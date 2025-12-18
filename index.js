import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { connectToDatabase } from './config/db.js';
import { initializeFirebase } from './services/fcmService.js';
import adminAuthRouter from './routes/adminAuth.js';
import teacherAuthRouter from './routes/teacherAuth.js';
import teacherManagementRouter from './routes/teacherManagement.js';
import taskRoutes from './routes/taskRoutes.js';
import teacherTaskAndLogs from './routes/teacherTaskAndLogs.js';
import messagesAndReports from './routes/messagesAndReports.js';
import adminSettings from './routes/adminSettings.js';
import reportExport from './routes/reportExport.js';
import excelRoutes from './routes/excelRoutes.js';
import { ensureDirectoryExists } from './utils/ensureDir.js';

dotenv.config();

// Initialize Firebase Admin SDK for FCM
initializeFirebase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));
ensureDirectoryExists('uploads');

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/admin', adminAuthRouter);
app.use('/teacher', teacherAuthRouter);
app.use('/admin', teacherManagementRouter);
app.use('/admin', taskRoutes);
app.use('/teacher', teacherTaskAndLogs);
app.use('/', messagesAndReports);
app.use('/admin', adminSettings);
app.use('/admin', reportExport);
app.use('/api/teacher', excelRoutes);

const port = process.env.PORT || 4000;

connectToDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Admin backend listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });


