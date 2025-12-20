import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { Excel } from '../models/Excel.js';
import { Task } from '../models/Task.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { s3Client, BUCKET_NAME } from '../config/s3.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { authenticateTeacher } from '../middleware/auth.js';

const router = express.Router();

// Get Excel files assigned to a teacher for a specific task
router.get(
  '/excel-files',
  authenticateTeacher,
  query('taskId').optional().isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { taskId } = req.query;
    const teacherId = req.user.teacher_id;

    try {
      let files = [];

      if (taskId) {
        // If specific taskId is provided, get Excel files for that task
        files = await Excel.find({ taskId })
          .sort({ uploadedAt: -1 })
          .select('excelId fileName originalFileName fileSize status contactsCount uploadedAt taskId');
      } else {
        // Get all tasks assigned to this teacher
        const teacherTasks = await Task.find({ 
          assigned_teacher_id: teacherId,
          status: { $in: ['pending', 'in-progress'] }
        }).select('task_id');

        if (teacherTasks.length > 0) {
          // Get task IDs
          const taskIds = teacherTasks.map(task => task.task_id);
          
          // Find Excel files for these tasks
          files = await Excel.find({ 
            taskId: { $in: taskIds }
          })
          .sort({ uploadedAt: -1 })
          .select('excelId fileName originalFileName fileSize status contactsCount uploadedAt taskId');
        }
      }

      res.json({ files });
    } catch (error) {
      console.error('Error fetching Excel files:', error);
      res.status(500).json({ message: 'Error fetching Excel files' });
    }
  })
);

// Download Excel file from S3
router.get(
  '/download-excel/:excelId',
  authenticateTeacher,
  param('excelId').isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { excelId } = req.params;
    const teacherId = req.user.teacher_id;

    // First check if the teacher has access to this file through their tasks
    const teacherTasks = await Task.find({ 
      assigned_teacher_id: teacherId,
      status: { $in: ['pending', 'in-progress'] }
    }).select('task_id');

    if (teacherTasks.length === 0) {
      return res.status(404).json({ message: 'No tasks assigned to you' });
    }

    const taskIds = teacherTasks.map(task => task.task_id);
    
    const file = await Excel.findOne({ 
      excelId, 
      taskId: { $in: taskIds }
    });

    if (!file) {
      return res.status(404).json({ message: 'File not found or not assigned to you' });
    }

    // Update task status from 'pending' to 'in-progress' when teacher downloads
    if (file.taskId) {
      try {
        const task = await Task.findOne({ task_id: file.taskId });
        if (task && task.status === 'pending') {
          await Task.updateOne(
            { task_id: file.taskId },
            { status: 'in-progress' }
          );
          console.log(`Task ${file.taskId} status updated from 'pending' to 'in-progress'`);
        }
      } catch (taskUpdateError) {
        console.error('Error updating task status on download:', taskUpdateError);
        // Don't fail the download if task update fails
      }
    }

    try {
      console.log('Attempting to download file:', {
        excelId,
        s3Key: file.s3Key,
        bucketName: BUCKET_NAME,
        fileSize: file.fileSize,
        originalFileName: file.originalFileName
      });

      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: file.s3Key,
      });

      const response = await s3Client.send(command);
      console.log('S3 response received:', {
        contentLength: response.ContentLength,
        contentType: response.ContentType,
        lastModified: response.LastModified
      });
      
      // Set appropriate headers for file download
      res.setHeader('Content-Type', file.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${file.originalFileName}"`);
      res.setHeader('Content-Length', file.fileSize);
      res.setHeader('Cache-Control', 'no-cache');

      // Handle the stream properly
      const stream = response.Body;
      
      // Convert the stream to buffer and send it
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      
      const buffer = Buffer.concat(chunks);
      console.log('Buffer size:', buffer.length);
      res.send(buffer);
      
    } catch (error) {
      console.error('Error downloading file from S3:', error);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Error downloading file' });
      }
    }
  })
);

// Get Excel file status and metadata
router.get(
  '/excel-status/:excelId',
  authenticateTeacher,
  param('excelId').isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { excelId } = req.params;
    const teacherId = req.user.teacher_id;

    // First check if the teacher has access to this file through their tasks
    const teacherTasks = await Task.find({ 
      assigned_teacher_id: teacherId,
      status: { $in: ['pending', 'in-progress'] }
    }).select('task_id');

    if (teacherTasks.length === 0) {
      return res.status(404).json({ message: 'No tasks assigned to you' });
    }

    const taskIds = teacherTasks.map(task => task.task_id);
    
    const file = await Excel.findOne({ 
      excelId, 
      taskId: { $in: taskIds }
    }).select('excelId fileName originalFileName status contactsCount uploadedAt processedAt');

    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    res.json({ file });
  })
);

// Get tasks assigned to a teacher
router.get(
  '/tasks',
  authenticateTeacher,
  asyncHandler(async (req, res) => {
    const teacherId = req.user.teacher_id;

    try {
      const tasks = await Task.find({ 
        assigned_teacher_id: teacherId,
        status: { $in: ['pending', 'in-progress'] }
      })
      .select('task_id task_name status created_at assigned_teacher_id excel_file_url')
      .sort({ created_at: -1 });

      res.json({ tasks });
    } catch (error) {
      console.error('Error fetching tasks:', error);
      res.status(500).json({ message: 'Error fetching tasks' });
    }
  })
);

// Get Excel files with auto-refresh support (for AJAX-like behavior)
router.get(
  '/excel-files/refresh',
  authenticateTeacher,
  query('lastUpdated').optional().isISO8601(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { lastUpdated } = req.query;
    const teacherId = req.user.teacher_id;

    try {
      // Get all tasks assigned to this teacher
      const teacherTasks = await Task.find({ 
        assigned_teacher_id: teacherId,
        status: { $in: ['pending', 'in-progress'] }
      }).select('task_id');

      let files = [];
      let hasUpdates = false;

      if (teacherTasks.length > 0) {
        // Get task IDs
        const taskIds = teacherTasks.map(task => task.task_id);
        
        let query = { taskId: { $in: taskIds } };
        
        // If lastUpdated is provided, only get files updated after that time
        if (lastUpdated) {
          query.uploadedAt = { $gt: new Date(lastUpdated) };
        }

        files = await Excel.find(query)
          .sort({ uploadedAt: -1 })
          .select('excelId fileName originalFileName fileSize status contactsCount uploadedAt taskId');

        hasUpdates = files.length > 0;
      }
      
      res.json({ 
        files,
        hasUpdates,
        lastChecked: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error refreshing Excel files:', error);
      res.status(500).json({ message: 'Error refreshing Excel files' });
    }
  })
);

export default router;
