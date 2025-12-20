import express from 'express';
import { query, validationResult } from 'express-validator';
import xlsx from 'xlsx';
import { requireAdmin } from '../middleware/auth.js';
import { CallLog } from '../models/CallLog.js';
import { Contact } from '../models/Contact.js';
import { Task } from '../models/Task.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

router.get(
  '/report/export',
  requireAdmin,
  query('teacher_id').optional().isString(),
  query('date').optional(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { teacher_id, date } = req.query;
    const filter = {};
    if (teacher_id) filter.teacher_id = teacher_id;
    if (date) {
      const dayStart = new Date(date);
      if (isNaN(dayStart.getTime())) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }
      dayStart.setHours(0, 0, 0, 0);
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

    const data = logs.map(l => {
      const c = l.contact_id ? contactMap.get(l.contact_id) : null;
      
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
      
      // Format call time for better readability
      let callTimeStr = '';
      if (l.call_time) {
        const callTime = new Date(l.call_time);
        callTimeStr = callTime.toLocaleString('en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
      }
      
      return {
        'Student Name': contactName,
        'Phone': contactPhone,
        'Status': l.call_status,
        'Notes': l.review_notes || '',
        'Call Time': callTimeStr,
        'Teacher ID': l.teacher_id
      };
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, 'Report');
    const buf = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="report.xlsx"');
    res.send(buf);
  })
);

export default router;


