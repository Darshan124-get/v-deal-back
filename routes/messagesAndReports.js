import express from 'express';
import multer from 'multer';
import xlsx from 'xlsx';
import { body, query, validationResult } from 'express-validator';
import { requireAdmin } from '../middleware/auth.js';
import { authenticateTeacher } from '../middleware/auth.js';
import { Message } from '../models/Message.js';
import { CallLog } from '../models/CallLog.js';
import { Contact } from '../models/Contact.js';
import { Task } from '../models/Task.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadToS3, generateS3Key } from '../config/s3.js';

const router = express.Router();

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// Admin sends message
router.post(
  '/admin/message',
  requireAdmin,
  body('receiver_teacher_id').isString(), // 'ALL' or teacher_id
  body('message_text').isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { receiver_teacher_id, message_text } = req.body;
    const msg = await Message.create({
      sender_admin_id: req.admin.admin_id,
      receiver_teacher_id,
      message_text
    });
    res.status(201).json({ message_id: msg.message_id });
  })
);

// Admin fetch all messages (both admin sent and teacher sent)
router.get(
  '/admin/messages',
  requireAdmin,
  query('teacher_id').optional().isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    const { teacher_id } = req.query;
    const filter = {};
    
    // If filtering by teacher, show messages to/from that teacher
    if (teacher_id && teacher_id !== 'ALL') {
      filter.$or = [
        { receiver_teacher_id: teacher_id },
        { receiver_teacher_id: 'ALL' },
        { sender_teacher_id: teacher_id }
      ];
    }
    // If no filter, show all messages
    // (no filter means show everything)
    
    const messages = await Message.find(filter, { _id: 0, __v: 0 })
      .sort({ created_at: 1 }); // Sort ascending (oldest first) for chat-like display
    
    res.json({ messages });
  })
);

// Teacher sends message to admin
router.post(
  '/api/teacher/message',
  authenticateTeacher,
  body('message_text').isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty) return res.status(400).json({ errors: errors.array() });
    
    const teacherId = req.user.teacher_id;
    const { message_text } = req.body;
    
    const msg = await Message.create({
      sender_teacher_id: teacherId,
      message_text
    });
    
    res.status(201).json({ message_id: msg.message_id });
  })
);

// Teacher fetch messages (both admin messages and teacher's own messages)
router.get(
  '/api/teacher/messages',
  authenticateTeacher,
  asyncHandler(async (req, res) => {
    const teacherId = req.user.teacher_id;
    
    // Get messages from admin (to this teacher or ALL)
    // AND messages sent by this teacher (to admin)
    const messages = await Message.find(
      { 
        $or: [
          // Admin messages sent to this specific teacher
          { sender_admin_id: { $exists: true, $ne: null }, receiver_teacher_id: teacherId },
          // Admin messages sent to ALL teachers
          { sender_admin_id: { $exists: true, $ne: null }, receiver_teacher_id: 'ALL' },
          // Messages sent by this teacher to admin
          { sender_teacher_id: teacherId }
        ] 
      },
      { _id: 0, __v: 0 }
    ).sort({ created_at: 1 }); // Sort ascending (oldest first) for chat-like display
    
    console.log(`Teacher ${teacherId} fetched ${messages.length} messages`);
    
    res.json({ messages });
  })
);

// Teacher submits daily report (JSON data - direct to MongoDB)
router.post(
  '/api/teacher/submit-report-json',
  authenticateTeacher,
  asyncHandler(async (req, res) => {
    console.log('Submit report JSON request received:', {
      teacherId: req.user?.teacher_id,
      date: req.body?.date,
      callNotesCount: req.body?.callNotes?.length || 0,
      bodyKeys: Object.keys(req.body || {})
    });

    const teacherId = req.user.teacher_id;
    const submittedDate = req.body.date ? new Date(req.body.date) : new Date();
    submittedDate.setHours(0, 0, 0, 0);
    const callNotes = req.body.callNotes || [];

    if (!Array.isArray(callNotes) || callNotes.length === 0) {
      return res.status(400).json({ 
        message: 'No call notes provided',
        error: 'Please provide an array of call notes to submit'
      });
    }

      try {
      const callLogsCreated = [];
      const taskIdsSet = new Set(); // Track unique task IDs from contacts that were called

      for (const note of callNotes) {
        const phoneNumber = String(note.phoneNumber || '').trim();
        const reviewType = String(note.reviewType || '').trim();
        const notes = String(note.notes || note.customNote || '').trim();
        const name = String(note.name || '').trim();
        const callTime = note.callTime ? new Date(note.callTime) : new Date();

        if (!phoneNumber || !reviewType) {
          console.warn('Skipping invalid call note:', note);
          continue;
        }

        // Map review type to call status
        const callStatusMap = {
          'answered': 'Received',
          'busy': 'Busy',
          'no_answer': 'Not Received',
          'wrong_number': 'Wrong Number',
          'not_interested': 'Call Later',
        };
        const reviewTypeLower = reviewType.toLowerCase();
        const callStatus = callStatusMap[reviewTypeLower] || 'Not Received';

        // Try to find contact_id by phone number
        let contactId = null;
        let contactTaskId = null;
        const contact = await Contact.findOne({ 
          phone_number: phoneNumber,
          assigned_teacher_id: teacherId 
        });
        if (contact) {
          contactId = contact.contact_id;
          contactTaskId = contact.task_id;
          // Track the task_id if contact belongs to a task
          if (contactTaskId) {
            taskIdsSet.add(contactTaskId);
          }
        }

        // Store only the user-entered note (not the formatted string with phone/name)
        const reviewNotes = notes || undefined;

        // Create CallLog entry in MongoDB
        // Store phone and name for cases where contact_id is null
        const callLogData = {
          teacher_id: teacherId,
          contact_id: contactId,
          call_status: callStatus,
          review_notes: reviewNotes,
          call_time: callTime,
          submitted_date: submittedDate,
        };
        
        // Add phone_number and contact_name if no contact found (for admin display)
        if (!contactId) {
          callLogData.phone_number = phoneNumber;
          callLogData.contact_name = name || undefined;
        }
        
        const callLog = await CallLog.create(callLogData);

        callLogsCreated.push(callLog.call_id);
      }

      // Update task status from 'in-progress' to 'completed' only for tasks where all contacts have been called
      try {
        const taskIds = Array.from(taskIdsSet);
        if (taskIds.length > 0) {
          for (const taskId of taskIds) {
            // Get all contacts for this task
            const allContacts = await Contact.find({ 
              task_id: taskId,
              assigned_teacher_id: teacherId
            }).select('contact_id');
            
            if (allContacts.length === 0) continue; // Skip if no contacts
            
            const totalContacts = allContacts.length;
            const contactIds = allContacts.map(c => c.contact_id);
            
            // Count how many contacts have at least one call log
            const contactsWithCallLogs = await CallLog.distinct('contact_id', {
              teacher_id: teacherId,
              contact_id: { $in: contactIds }
            });
            
            const calledContactsCount = contactsWithCallLogs.length;
            
            // Only mark task as completed if all contacts have been called
            if (calledContactsCount >= totalContacts) {
              const updatedTask = await Task.findOneAndUpdate(
                { 
                  task_id: taskId,
                  assigned_teacher_id: teacherId,
                  status: 'in-progress'
                },
                { 
                  status: 'completed',
                  completed_at: new Date()
                },
                { new: true }
              );
              
              if (updatedTask) {
                console.log(`Task ${taskId} marked as completed - all ${totalContacts} contacts have been called`);
              }
            } else {
              console.log(`Task ${taskId} not completed yet - ${calledContactsCount}/${totalContacts} contacts called`);
            }
          }
        }
      } catch (taskUpdateError) {
        console.error('Error updating task status on report submission:', taskUpdateError);
        // Don't fail the submission if task update fails
      }

      console.log('Report submitted successfully to MongoDB:', {
        teacherId: teacherId,
        submittedDate: submittedDate.toISOString(),
        logsCreated: callLogsCreated.length,
        totalNotes: callNotes.length
      });

      res.status(201).json({
        message: 'Report submitted successfully',
        logsCreated: callLogsCreated.length,
        submittedDate: submittedDate.toISOString(),
      });
    } catch (error) {
      console.error('Error submitting report to MongoDB:', error);
      console.error('Error stack:', error.stack);
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        teacherId: req.user?.teacher_id
      });
      
      const statusCode = error.message.includes('validation') || error.message.includes('required') ? 400 : 500;
      res.status(statusCode).json({ 
        message: 'Failed to submit report', 
        error: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  })
);

// Teacher submits daily report (Excel file) - kept for backward compatibility
router.post(
  '/api/teacher/submit-report',
  authenticateTeacher,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    console.log('Submit report request received:', {
      hasFile: !!req.file,
      fileSize: req.file?.size,
      fileName: req.file?.originalname,
      fileMimeType: req.file?.mimetype,
      hasBuffer: !!req.file?.buffer,
      bufferLength: req.file?.buffer?.length,
      teacherId: req.user?.teacher_id,
      date: req.body?.date,
      bodyKeys: Object.keys(req.body || {})
    });

    if (!req.file) {
      console.error('No file received in request');
      return res.status(400).json({ message: 'File is required' });
    }

    const teacherId = req.user.teacher_id;
    const submittedDate = req.body.date ? new Date(req.body.date) : new Date();
    submittedDate.setHours(0, 0, 0, 0);

    try {
      // Parse Excel file
      let workbook;
      try {
        if (!req.file.buffer || req.file.buffer.length === 0) {
          console.error('File buffer is empty:', {
            hasBuffer: !!req.file.buffer,
            bufferLength: req.file.buffer?.length,
            fileSize: req.file.size
          });
          return res.status(400).json({ 
            message: 'File buffer is empty or missing',
            error: 'The uploaded file appears to be empty or corrupted'
          });
        }
        
        workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        
        if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
          return res.status(400).json({ 
            message: 'Invalid Excel file format',
            error: 'The file does not contain any worksheets'
          });
        }
      } catch (excelError) {
        console.error('Excel parsing error:', excelError);
        return res.status(400).json({ 
          message: 'Failed to parse Excel file', 
          error: excelError.message || 'Invalid Excel file format. Please ensure the file is a valid .xlsx file.'
        });
      }

      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

      // Filter out header row if it exists (first row with column names)
      const dataRows = rows.filter(row => {
        // Skip if this looks like a header row (all values are column names)
        const firstCell = String(row['Phone Number'] || row['Phone'] || '').trim();
        return firstCell !== 'Phone Number' && firstCell !== 'Phone' && firstCell !== '';
      });

      console.log('Excel parsed successfully:', {
        sheetName: sheetName,
        totalRows: rows.length,
        dataRows: dataRows.length,
        firstRow: dataRows[0] || null
      });

      if (dataRows.length === 0) {
        console.error('No data rows found in Excel file');
        return res.status(400).json({ message: 'Excel file contains no data rows. Please ensure there are call notes to submit.' });
      }

      // Process rows and create/update CallLog entries
      const callLogsCreated = [];
      const todayEnd = new Date(submittedDate);
      todayEnd.setDate(todayEnd.getDate() + 1);

      for (const row of dataRows) {
        const phoneNumber = String(row['Phone Number'] || '').trim();
        const reviewType = String(row['Review Type'] || '').trim();
        const notes = String(row['Notes'] || '').trim();
        const dateStr = String(row['Date'] || '').trim();
        const timeStr = String(row['Time'] || '').trim();

        if (!phoneNumber || !reviewType) continue;

        // Parse date and time
        let callTime = new Date();
        if (dateStr) {
          const dateParts = dateStr.split('/');
          if (dateParts.length === 3) {
            const day = parseInt(dateParts[0]);
            const month = parseInt(dateParts[1]) - 1;
            const year = parseInt(dateParts[2]);
            callTime = new Date(year, month, day);
            
            if (timeStr) {
              const timeParts = timeStr.split(':');
              if (timeParts.length >= 2) {
                callTime.setHours(parseInt(timeParts[0]), parseInt(timeParts[1]), 0, 0);
              }
            }
          }
        }

        // Map review type to call status
        const callStatusMap = {
          'answered': 'Received',
          'busy': 'Busy',
          'no_answer': 'Not Received',
          'wrong_number': 'Wrong Number',
          'not_interested': 'Call Later',
        };
        const reviewTypeLower = reviewType.toLowerCase();
        const callStatus = callStatusMap[reviewTypeLower] || 'Not Received';

        // Try to find contact_id by phone number (search across all tasks for this teacher)
        let contactId = null;
        const contact = await Contact.findOne({ 
          phone_number: phoneNumber,
          assigned_teacher_id: teacherId 
        });
        if (contact) {
          contactId = contact.contact_id;
        }

        // Store only the user-entered note (not the formatted string with phone/name)
        const reviewNotes = notes || undefined;

        // Create or update CallLog entry
        const callLogData = {
          teacher_id: teacherId,
          contact_id: contactId,
          call_status: callStatus,
          review_notes: reviewNotes,
          call_time: callTime,
          submitted_date: submittedDate,
        };
        
        // Add phone_number and contact_name if no contact found (for admin display)
        if (!contactId) {
          const name = String(row['Name'] || '').trim();
          callLogData.phone_number = phoneNumber;
          callLogData.contact_name = name || undefined;
        }
        
        const callLog = await CallLog.create(callLogData);

        callLogsCreated.push(callLog.call_id);
      }

      // Upload file to S3 for record keeping
      let s3Url = null;
      try {
        const s3Key = `reports/teacher-${teacherId}/${submittedDate.toISOString().split('T')[0]}_${req.file.originalname}`;
        const uploadResult = await uploadToS3(req.file, s3Key);
        if (uploadResult.success) {
          s3Url = uploadResult.location;
        }
      } catch (s3Error) {
        console.error('S3 upload error (non-critical):', s3Error);
        // Don't fail the submission if S3 upload fails
      }

      console.log('Report submitted successfully:', {
        teacherId: teacherId,
        submittedDate: submittedDate.toISOString(),
        logsCreated: callLogsCreated.length,
        s3Url: s3Url
      });

      res.status(201).json({
        message: 'Report submitted successfully',
        logsCreated: callLogsCreated.length,
        submittedDate: submittedDate.toISOString(),
        s3Url: s3Url,
      });
    } catch (error) {
      console.error('Error submitting report:', error);
      console.error('Error stack:', error.stack);
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        teacherId: req.user?.teacher_id
      });
      
      // Return 400 for validation errors, 500 for server errors
      const statusCode = error.message.includes('validation') || error.message.includes('required') ? 400 : 500;
      res.status(statusCode).json({ 
        message: 'Failed to submit report', 
        error: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  })
);

// Admin reports
router.get(
  '/reports',
  requireAdmin,
  query('teacher_id').optional().isString(),
  query('date').optional(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { teacher_id, date } = req.query;
    console.log('Reports filter request:', { teacher_id, date, query: req.query });
    
    const filter = {};
    if (teacher_id) {
      filter.teacher_id = teacher_id;
    }
    if (date) {
      // Accept date in YYYY-MM-DD format (from HTML date input)
      const dayStart = new Date(date);
      if (isNaN(dayStart.getTime())) {
        console.error('Invalid date format:', date);
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      filter.submitted_date = { $gte: dayStart, $lt: dayEnd };
      console.log('Date filter:', { dayStart: dayStart.toISOString(), dayEnd: dayEnd.toISOString() });
    }
    
    console.log('MongoDB filter:', JSON.stringify(filter, null, 2));
    const logs = await CallLog.find(filter).lean();
    console.log(`Found ${logs.length} call logs matching filter`);
    
    // Join with contacts to get names and phone numbers
    const contactIds = logs.map(l => l.contact_id).filter(Boolean);
    const contacts = contactIds.length > 0 
      ? await Contact.find({ contact_id: { $in: contactIds } }).lean()
      : [];
    const contactMap = new Map(contacts.map(c => [c.contact_id, c]));
    
    // Join with tasks to get task_id
    const taskIds = [...new Set(contacts.map(c => c.task_id).filter(Boolean))];
    const tasks = taskIds.length > 0
      ? await Task.find({ task_id: { $in: taskIds } }).lean()
      : [];
    
      // Format logs with contact and task info
      const formattedLogs = logs.map(l => {
        const c = l.contact_id ? contactMap.get(l.contact_id) : null;
        const t = c && c.task_id ? tasks.find(t => t.task_id === c.task_id) : null;
        
        // Get phone and name from contact if available, otherwise from CallLog fields
        let contactPhone = c?.phone_number || l.phone_number || '';
        let contactName = c?.name || l.contact_name || '';
        
        // Fallback: Try to extract from review_notes for old data format
        if (!contactPhone && l.review_notes) {
          const phoneMatch = l.review_notes.match(/Phone:\s*([^,|]+)/);
          if (phoneMatch) {
            contactPhone = phoneMatch[1].trim();
          }
        }
        if (!contactName && l.review_notes) {
          const nameMatch = l.review_notes.match(/Name:\s*([^|]+)/);
          if (nameMatch) {
            contactName = nameMatch[1].trim();
          }
        }
        
        return {
          ...l,
          contact_name: contactName,
          contact_phone: contactPhone,
          task_id: t?.task_id || '',
          _id: undefined,
          __v: undefined
        };
      });
    
    res.json({ logs: formattedLogs });
  })
);

export default router;


