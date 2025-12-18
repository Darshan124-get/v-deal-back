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
  '/message',
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

// Teacher fetch messages
router.get(
  '/teacher/messages',
  asyncHandler(async (req, res) => {
    const teacherId = req.query.teacher_id;
    const messages = await Message.find(
      { $or: [{ receiver_teacher_id: 'ALL' }, { receiver_teacher_id: teacherId }] },
      { _id: 0, __v: 0 }
    ).sort({ created_at: -1 });
    res.json({ messages });
  })
);

// Teacher submits daily report (Excel file)
router.post(
  '/api/teacher/submit-report',
  authenticateTeacher,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: 'File is required' });
    }

    const teacherId = req.user.teacher_id;
    const submittedDate = req.body.date ? new Date(req.body.date) : new Date();
    submittedDate.setHours(0, 0, 0, 0);

    try {
      // Parse Excel file
      let workbook;
      try {
        if (req.file.buffer) {
          workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        } else {
          throw new Error('File buffer not available');
        }
      } catch (excelError) {
        return res.status(400).json({ 
          message: 'Failed to parse Excel file', 
          error: excelError.message 
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

      if (dataRows.length === 0) {
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

        // Build review notes with phone number if no contact found
        let reviewNotes = notes || '';
        if (!contactId && phoneNumber) {
          const name = String(row['Name'] || '').trim();
          reviewNotes = `Phone: ${phoneNumber}${name ? `, Name: ${name}` : ''}${reviewNotes ? ` | ${reviewNotes}` : ''}`.trim();
        }

        // Create or update CallLog entry
        const callLog = await CallLog.create({
          teacher_id: teacherId,
          contact_id: contactId,
          call_status: callStatus,
          review_notes: reviewNotes || undefined,
          call_time: callTime,
          submitted_date: submittedDate,
        });

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

      res.status(201).json({
        message: 'Report submitted successfully',
        logsCreated: callLogsCreated.length,
        submittedDate: submittedDate.toISOString(),
        s3Url: s3Url,
      });
    } catch (error) {
      console.error('Error submitting report:', error);
      
      // Return 400 for validation errors, 500 for server errors
      const statusCode = error.message.includes('validation') || error.message.includes('required') ? 400 : 500;
      res.status(statusCode).json({ 
        message: 'Failed to submit report', 
        error: error.message 
      });
    }
  })
);

// Admin reports
router.get(
  '/reports',
  requireAdmin,
  query('teacher_id').optional().isString(),
  query('date').optional().isISO8601(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { teacher_id, date } = req.query;
    const filter = {};
    if (teacher_id) filter.teacher_id = teacher_id;
    if (date) {
      const dayStart = new Date(date);
      dayStart.setHours(0,0,0,0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      filter.submitted_date = { $gte: dayStart, $lt: dayEnd };
    }
    const logs = await CallLog.find(filter).lean();
    
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
      
      // Extract phone from review_notes if no contact found (format: "Phone: XXX")
      let contactPhone = c?.phone_number || '';
      let contactName = c?.name || '';
      if (!contactPhone && l.review_notes) {
        const phoneMatch = l.review_notes.match(/Phone:\s*([^,|]+)/);
        if (phoneMatch) {
          contactPhone = phoneMatch[1].trim();
        }
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


