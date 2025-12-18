import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { Teacher } from '../models/Teacher.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticateTeacher } from '../middleware/auth.js';

const router = express.Router();

router.post(
  '/login',
  body('email').custom((value) => {
    // Allow email or phone number
    const emailRegex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;
    const phoneRegex = /^\+?[\d\s\-\(\)]{10,}$/;
    
    if (!emailRegex.test(value) && !phoneRegex.test(value)) {
      throw new Error('Please provide a valid email or phone number');
    }
    return true;
  }),
  body('password').isString().isLength({ min: 6 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    
    // Check if it's an email or phone number
    const emailRegex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;
    const isEmail = emailRegex.test(email);
    
    let teacher;
    if (isEmail) {
      teacher = await Teacher.findOne({ email });
    } else {
      teacher = await Teacher.findOne({ phone: email });
    }
    
    if (!teacher) return res.status(401).json({ message: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, teacher.password_hash);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign(
      { role: 'teacher', teacher_id: teacher.teacher_id },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({
      token,
      teacher: {
        teacher_id: teacher.teacher_id,
        name: teacher.name,
        email: teacher.email,
        phone: teacher.phone,
        status: teacher.status
      }
    });
  })
);

// Update FCM token for teacher
router.post(
  '/fcm-token',
  authenticateTeacher,
  body('fcm_token').isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { fcm_token } = req.body;
    const teacher_id = req.user.teacher_id;

    try {
      await Teacher.findOneAndUpdate(
        { teacher_id },
        { fcm_token },
        { new: true }
      );
      
      res.json({ 
        ok: true, 
        message: 'FCM token updated successfully' 
      });
    } catch (error) {
      res.status(500).json({ 
        message: 'Error updating FCM token', 
        error: error.message 
      });
    }
  })
);

// Temporary endpoint to create test teacher (remove in production)
router.post(
  '/create-test-teacher',
  asyncHandler(async (req, res) => {
    try {
      const { name, email, phone, password } = req.body;
      
      // Check if teacher already exists
      const existing = await Teacher.findOne({ $or: [{ email }, { phone }] });
      if (existing) {
        return res.json({
          message: 'Teacher already exists',
          teacher: {
            name: existing.name,
            email: existing.email,
            phone: existing.phone
          }
        });
      }
      
      // Create new teacher
      const password_hash = await bcrypt.hash(password, 10);
      const teacher = await Teacher.create({
        name: name || 'Test Teacher',
        email: email || 'teacher@test.com',
        phone: phone || '6364594854',
        password_hash,
        status: 'active'
      });
      
      res.json({
        message: 'Test teacher created successfully',
        teacher: {
          name: teacher.name,
          email: teacher.email,
          phone: teacher.phone,
          password: password
        }
      });
    } catch (error) {
      res.status(500).json({ message: 'Error creating teacher', error: error.message });
    }
  })
);

export default router;


