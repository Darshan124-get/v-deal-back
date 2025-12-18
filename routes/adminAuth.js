import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { Admin } from '../models/Admin.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

router.post(
  '/login',
  body('email').isEmail(),
  body('password').isString().isLength({ min: 6 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    
    // Normalize email: trim and convert to lowercase (matching schema)
    const normalizedEmail = email.trim().toLowerCase();
    
    console.log('Login attempt for email:', normalizedEmail);
    
    const admin = await Admin.findOne({ email: normalizedEmail });
    
    if (!admin) {
      console.log('Admin not found for email:', normalizedEmail);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    console.log('Admin found:', admin.email, 'Comparing password...');
    
    // Check if password_hash exists
    if (!admin.password_hash) {
      console.error('Admin has no password_hash!');
      return res.status(500).json({ message: 'Admin account configuration error' });
    }

    const ok = await bcrypt.compare(password, admin.password_hash);
    
    if (!ok) {
      console.log('Password comparison failed for:', normalizedEmail);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    console.log('Login successful for:', normalizedEmail);

    // Check JWT_SECRET
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not set!');
      return res.status(500).json({ message: 'Server configuration error' });
    }

    const token = jwt.sign(
      { role: 'admin', admin_id: admin.admin_id },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    
    // Generate presigned URL for profile image if it exists
    let profileImageUrl = admin.profile_image_url || null;
    if (profileImageUrl) {
      try {
        const { generatePresignedUrl } = await import('../config/s3.js');
        const urlParts = profileImageUrl.split('.com/');
        if (urlParts.length > 1) {
          const s3Key = urlParts[1].split('?')[0];
          const presignedResult = await generatePresignedUrl(s3Key, 604800); // 1 week (max allowed by AWS)
          if (presignedResult.success) {
            profileImageUrl = presignedResult.url;
          }
        }
      } catch (error) {
        console.error('Error generating presigned URL for profile image:', error);
      }
    }
    
    res.json({ 
      token, 
      admin: { 
        admin_id: admin.admin_id, 
        name: admin.name, 
        email: admin.email,
        profile_image_url: profileImageUrl
      } 
    });
  })
);

export default router;


