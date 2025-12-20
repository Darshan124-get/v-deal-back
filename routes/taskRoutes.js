import express from 'express';
import multer from 'multer';
import xlsx from 'xlsx';
import { body, param, validationResult } from 'express-validator';
import { requireAdmin } from '../middleware/auth.js';
import { Task } from '../models/Task.js';
import { Contact } from '../models/Contact.js';
import { Excel } from '../models/Excel.js';
import { Teacher } from '../models/Teacher.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadToS3, generateS3Key, deleteFromS3, generatePresignedUrl } from '../config/s3.js';
import { sendNotificationToTeacher } from '../services/fcmService.js';

const router = express.Router();

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// Upload Excel, create Task and Contacts
router.post(
  '/task/upload',
  requireAdmin,
  upload.single('file'),
  body('assigned_teacher_id').optional().isString(),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'File is required' });
    
    const assigned_teacher_id = req.body.assigned_teacher_id || null;
    const uploadedBy = req.admin.admin_id; // Get admin ID from auth middleware
    const taskName = req.file.originalname.replace(/\.[^/.]+$/, ''); // Remove file extension

    try {
      // Create task first to get task_id
      const task = await Task.create({
        task_name: taskName,
        assigned_teacher_id,
        excel_file_url: '', // Will be updated with S3 URL
        status: 'pending'
      });

      // Generate S3 key and upload file
      const s3Key = generateS3Key(req.file.originalname, task.task_id);
      
      console.log('Uploading file to S3:', {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        bufferLength: req.file.buffer ? req.file.buffer.length : 'no buffer',
        s3Key: s3Key
      });
      
      // Upload to S3 - REQUIRED
      const uploadResult = await uploadToS3(req.file, s3Key);

      if (!uploadResult.success) {
        // If S3 upload fails, clean up the task
        await Task.deleteOne({ task_id: task.task_id });
        
        // Provide detailed error message
        let errorMessage = 'Failed to upload file to S3';
        let errorDetails = uploadResult.error || 'Unknown error';
        
        if (errorDetails.includes('credentials') || errorDetails.includes('not valid') || errorDetails.includes('Resolved credential')) {
          errorMessage = 'AWS S3 credentials are invalid or not configured. Please check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env file.';
          errorDetails = 'Invalid AWS credentials. Please verify your AWS credentials are correct.';
        } else if (errorDetails.includes('bucket') || errorDetails.includes('NoSuchBucket')) {
          errorMessage = `S3 bucket "${process.env.S3_BUCKET_NAME || 'bialdesk'}" not found or inaccessible. Please check bucket name and permissions.`;
          errorDetails = `Bucket "${process.env.S3_BUCKET_NAME || 'bialdesk'}" does not exist or you don't have access.`;
        } else if (errorDetails.includes('AccessDenied')) {
          errorMessage = 'Access denied to S3 bucket. Please check AWS IAM permissions.';
          errorDetails = 'Your AWS credentials do not have permission to upload to this bucket.';
        }
        
        console.error('S3 Upload Failed:', {
          error: errorDetails,
          bucket: process.env.S3_BUCKET_NAME,
          region: process.env.AWS_REGION,
          hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
          hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY
        });
        
        return res.status(500).json({ 
          message: errorMessage,
          error: errorDetails,
          aws_config: {
            bucket: process.env.S3_BUCKET_NAME,
            region: process.env.AWS_REGION,
            has_credentials: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
          }
        });
      }

      const s3Url = uploadResult.location;

      // Update task with S3 URL or local URL
      await Task.findOneAndUpdate(
        { task_id: task.task_id },
        { excel_file_url: s3Url }
      );

      // Create Excel metadata record
      const excelRecord = await Excel.create({
        fileName: taskName,
        originalFileName: req.file.originalname,
        s3Url: s3Url,
        s3Key: s3Key,
        assignedTo: assigned_teacher_id,
        uploadedBy: uploadedBy,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        taskId: task.task_id,
        status: 'uploaded'
      });

      // Process Excel file to extract contacts
      // Since we're using memoryStorage, read from buffer instead of path
      let wb;
      try {
        if (req.file.buffer) {
          wb = xlsx.read(req.file.buffer, { type: 'buffer' });
        } else if (req.file.path) {
          wb = xlsx.readFile(req.file.path);
        } else {
          throw new Error('File buffer or path not available');
        }
      } catch (excelError) {
        console.error('Excel parsing error:', excelError);
        // Clean up task if Excel parsing fails
        await Task.deleteOne({ task_id: task.task_id });
        await Excel.deleteOne({ excelId: excelRecord.excelId });
        return res.status(400).json({ 
          message: 'Failed to parse Excel file. Please ensure it is a valid Excel file.',
          error: excelError.message 
        });
      }
      
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

      const contactsToInsert = [];
      for (const row of rows) {
        const name = String(row['Student Name'] || row['Name'] || '').trim();
        const phone_number = String(row['Phone'] || row['Phone Number'] || row['Mobile'] || '').trim();
        if (!name || !phone_number) continue;
        contactsToInsert.push({
          task_id: task.task_id,
          assigned_teacher_id,
          name,
          phone_number
        });
      }

      if (contactsToInsert.length) {
        await Contact.insertMany(contactsToInsert);
        
        // Update Excel record with contacts count and status
        await Excel.findOneAndUpdate(
          { excelId: excelRecord.excelId },
          { 
            contactsCount: contactsToInsert.length,
            status: 'processed',
            processedAt: new Date()
          }
        );
      }

      // Send FCM notification if teacher was assigned during upload
      if (assigned_teacher_id) {
        try {
          const teacher = await Teacher.findOne({ teacher_id: assigned_teacher_id });
          if (teacher && teacher.fcm_token) {
            const notificationResult = await sendNotificationToTeacher(
              teacher.fcm_token,
              'New Task Assigned',
              `You have been assigned a new task: ${task.task_name}`,
              {
                type: 'task_assigned',
                task_id: task.task_id,
                task_name: task.task_name,
              }
            );
            
            if (!notificationResult.success) {
              console.warn('Failed to send FCM notification:', notificationResult.error);
              // Don't fail the request if notification fails
            }
          } else {
            console.log(`Teacher ${assigned_teacher_id} does not have an FCM token registered`);
          }
        } catch (notificationError) {
          console.error('Error sending notification:', notificationError);
          // Don't fail the request if notification fails
        }
      }

      // Clean up local file if it exists (only if using diskStorage)
      if (req.file.path) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
        } catch (cleanupError) {
          console.warn('Failed to cleanup local file:', cleanupError);
          // Don't fail the request if cleanup fails
        }
      }

      res.status(201).json({ 
        task: {
          task_id: task.task_id,
          task_name: task.task_name,
          status: task.status
        },
        excel_id: excelRecord.excelId,
        contacts_created: contactsToInsert.length,
        s3_url: s3Url,
        message: 'Task created successfully',
        storage_mode: 's3'
      });

    } catch (error) {
      console.error('Upload error:', error);
      console.error('Error stack:', error.stack);
      
      // Clean up task if it was created
      if (task && task.task_id) {
        try {
          await Task.deleteOne({ task_id: task.task_id });
          // Also try to delete Excel record if it exists
          const excelRecord = await Excel.findOne({ taskId: task.task_id });
          if (excelRecord) {
            await Excel.deleteOne({ excelId: excelRecord.excelId });
          }
        } catch (cleanupError) {
          console.error('Failed to cleanup task:', cleanupError);
        }
      }
      
      // Provide user-friendly error message
      let errorMessage = 'Failed to create task';
      if (error.message) {
        if (error.message.includes('S3') || error.message.includes('AWS')) {
          errorMessage = 'File upload failed. Please check AWS S3 configuration.';
        } else if (error.message.includes('Excel') || error.message.includes('parse')) {
          errorMessage = 'Failed to parse Excel file. Please ensure it is a valid Excel file with "Student Name" and "Phone" columns.';
        } else {
          errorMessage = error.message;
        }
      }
      
      res.status(500).json({ 
        message: errorMessage,
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
      
      // Clean up local file
      const fs = await import('fs');
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (unlinkError) {
          console.error('Error cleaning up local file:', unlinkError);
        }
      }

      res.status(500).json({ 
        message: 'Upload failed', 
        error: error.message 
      });
    }
  })
);

// Assign task to a specific teacher
router.post(
  '/task/assign/:teacher_id',
  requireAdmin,
  param('teacher_id').isString(),
  body('task_id').isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { teacher_id } = req.params;
    const { task_id } = req.body;

    const task = await Task.findOneAndUpdate(
      { task_id },
      { assigned_teacher_id: teacher_id, status: 'in-progress' },
      { new: true }
    );
    if (!task) return res.status(404).json({ message: 'Task not found' });
    await Contact.updateMany({ task_id }, { assigned_teacher_id: teacher_id });
    
    // Send FCM notification to teacher
    try {
      const teacher = await Teacher.findOne({ teacher_id });
      if (teacher && teacher.fcm_token) {
        const notificationResult = await sendNotificationToTeacher(
          teacher.fcm_token,
          'New Task Assigned',
          `You have been assigned a new task: ${task.task_name}`,
          {
            type: 'task_assigned',
            task_id: task.task_id,
            task_name: task.task_name,
          }
        );
        
        if (!notificationResult.success) {
          console.warn('Failed to send FCM notification:', notificationResult.error);
          // Don't fail the request if notification fails
        }
      } else {
        console.log(`Teacher ${teacher_id} does not have an FCM token registered`);
      }
    } catch (notificationError) {
      console.error('Error sending notification:', notificationError);
      // Don't fail the request if notification fails
    }
    
    res.json({ ok: true });
  })
);

// List tasks
router.get(
  '/tasks',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const tasks = await Task.find({}, { _id: 0, __v: 0 });
    res.json({ tasks });
  })
);

// Get a single task and its contacts summary
router.get(
  '/task/:id',
  requireAdmin,
  param('id').isString(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const task = await Task.findOne({ task_id: id }, { _id: 0, __v: 0 });
    if (!task) return res.status(404).json({ message: 'Task not found' });
    const total = await Contact.countDocuments({ task_id: id });
    const completed = await Contact.countDocuments({ task_id: id, status: 'completed' });
    res.json({ task, stats: { total, completed, pending: total - completed } });
  })
);

// Update task
router.put(
  '/task/:id',
  requireAdmin,
  param('id').isString(),
  body('task_name').optional().isString(),
  body('status').optional().isIn(['pending', 'in-progress', 'completed']),
  body('assigned_teacher_id').optional().isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    const { id } = req.params;
    const update = { ...req.body };
    if (update.assigned_teacher_id === '') update.assigned_teacher_id = null;
    
    // Remove status from update - status is automatically managed based on teacher actions
    delete update.status;
    
    const oldTask = await Task.findOne({ task_id: id });
    if (!oldTask) return res.status(404).json({ message: 'Task not found' });
    
    const task = await Task.findOneAndUpdate({ task_id: id }, update, { new: true });
    
    // Update contacts if teacher assignment changed
    if (req.body.assigned_teacher_id !== undefined && 
        oldTask.assigned_teacher_id !== update.assigned_teacher_id &&
        update.assigned_teacher_id) {
      await Contact.updateMany({ task_id: id }, { assigned_teacher_id: update.assigned_teacher_id });
      
      // Send FCM notification if task is being assigned to a new teacher
      try {
        const teacher = await Teacher.findOne({ teacher_id: update.assigned_teacher_id });
        if (teacher && teacher.fcm_token) {
          const notificationResult = await sendNotificationToTeacher(
            teacher.fcm_token,
            'New Task Assigned',
            `You have been assigned a new task: ${task.task_name}`,
            {
              type: 'task_assigned',
              task_id: task.task_id,
              task_name: task.task_name,
            }
          );
          
          if (!notificationResult.success) {
            console.warn('Failed to send FCM notification:', notificationResult.error);
          }
        }
      } catch (notificationError) {
        console.error('Error sending notification:', notificationError);
        // Don't fail the request if notification fails
      }
    }
    
    res.json({ task });
  })
);

// Delete task
router.delete(
  '/task/:id',
  requireAdmin,
  param('id').isString(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    try {
      // Find Excel record to get S3 key
      const excelRecord = await Excel.findOne({ taskId: id });
      
      // Delete associated contacts first
      await Contact.deleteMany({ task_id: id });
      
      // Delete from S3 if Excel record exists
      if (excelRecord && excelRecord.s3Key) {
        const deleteResult = await deleteFromS3(excelRecord.s3Key);
        if (!deleteResult.success) {
          console.error('Failed to delete from S3:', deleteResult.error);
        }
        
        // Delete Excel metadata
        await Excel.deleteOne({ excelId: excelRecord.excelId });
      }
      
      // Delete task
      const result = await Task.deleteOne({ task_id: id });
      if (result.deletedCount === 0) return res.status(404).json({ message: 'Task not found' });
      
      res.json({ ok: true });
    } catch (error) {
      console.error('Delete task error:', error);
      res.status(500).json({ message: 'Failed to delete task', error: error.message });
    }
  })
);

// Get all Excel files with metadata
router.get(
  '/excel-files',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, status, assignedTo } = req.query;
    const query = {};
    
    if (status) query.status = status;
    if (assignedTo) query.assignedTo = assignedTo;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const excelFiles = await Excel.find(query)
      .sort({ uploadedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-_id -__v');
    
    const total = await Excel.countDocuments(query);
    
    res.json({
      excelFiles,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });
  })
);

// Get single Excel file details
router.get(
  '/excel-file/:id',
  requireAdmin,
  param('id').isString(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const excelFile = await Excel.findOne({ excelId: id }).select('-_id -__v');
    if (!excelFile) return res.status(404).json({ message: 'Excel file not found' });
    
    res.json({ excelFile });
  })
);

// Generate pre-signed URL for Excel file download
router.get(
  '/excel-file/:id/download',
  requireAdmin,
  param('id').isString(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const excelFile = await Excel.findOne({ excelId: id });
    if (!excelFile) return res.status(404).json({ message: 'Excel file not found' });
    
    const presignedResult = await generatePresignedUrl(excelFile.s3Key, 3600); // 1 hour expiry
    
    if (!presignedResult.success) {
      return res.status(500).json({ 
        message: 'Failed to generate download URL', 
        error: presignedResult.error 
      });
    }
    
    res.json({ 
      downloadUrl: presignedResult.url,
      fileName: excelFile.originalFileName,
      expiresIn: 3600
    });
  })
);

// Delete Excel file (standalone)
router.delete(
  '/excel-file/:id',
  requireAdmin,
  param('id').isString(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    try {
      const excelFile = await Excel.findOne({ excelId: id });
      if (!excelFile) return res.status(404).json({ message: 'Excel file not found' });
      
      // Delete from S3
      const deleteResult = await deleteFromS3(excelFile.s3Key);
      if (!deleteResult.success) {
        console.error('Failed to delete from S3:', deleteResult.error);
        return res.status(500).json({ 
          message: 'Failed to delete file from S3', 
          error: deleteResult.error 
        });
      }
      
      // Delete associated contacts if task exists
      if (excelFile.taskId) {
        await Contact.deleteMany({ task_id: excelFile.taskId });
        await Task.deleteOne({ task_id: excelFile.taskId });
      }
      
      // Delete Excel metadata
      await Excel.deleteOne({ excelId: id });
      
      res.json({ ok: true });
    } catch (error) {
      console.error('Delete Excel file error:', error);
      res.status(500).json({ message: 'Failed to delete Excel file', error: error.message });
    }
  })
);

export default router;


