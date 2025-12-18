import express from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { requireAdmin } from '../middleware/auth.js';
import { Admin } from '../models/Admin.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadToS3, deleteFromS3, generatePresignedUrl } from '../config/s3.js';

const router = express.Router();

// Multer configuration for profile image upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for images
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.'));
    }
  }
});

// Get admin profile
router.get(
  '/profile',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { admin_id } = req.admin;
    const admin = await Admin.findOne({ admin_id }, { password_hash: 0, _id: 0, __v: 0 });
    if (!admin) return res.status(404).json({ message: 'Admin not found' });
    
    // Generate presigned URL for profile image if it exists
    if (admin.profile_image_url) {
      try {
        // Check if URL is already presigned (contains signature)
        const isPresigned = admin.profile_image_url.includes('X-Amz-Signature') || admin.profile_image_url.includes('X-Amz-Algorithm');
        if (!isPresigned) {
          // Extract S3 key from URL
          const urlParts = admin.profile_image_url.split('.com/');
          if (urlParts.length > 1) {
            const s3Key = urlParts[1].split('?')[0]; // Remove query params if any
            const presignedResult = await generatePresignedUrl(s3Key, 604800); // 1 week (max allowed by AWS)
            if (presignedResult.success) {
              admin.profile_image_url = presignedResult.url;
            }
          }
        }
      } catch (error) {
        console.error('Error generating presigned URL for profile image:', error);
        // Continue with original URL if presigned URL generation fails
      }
    }
    
    res.json({ admin });
  })
);

// Update admin profile (name, email, additional_info)
router.put(
  '/profile',
  requireAdmin,
  body('name').optional().isString().trim().isLength({ min: 1, max: 100 }),
  body('email').optional().isEmail().normalizeEmail(),
  body('additional_info.phone').optional().isString(),
  body('additional_info.department').optional().isString(),
  body('additional_info.bio').optional().isString(),
  body('additional_info.address').optional().isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    const { admin_id } = req.admin;
    const { name, email, additional_info } = req.body;
    
    const admin = await Admin.findOne({ admin_id });
    if (!admin) return res.status(404).json({ message: 'Admin not found' });
    
    // Check if email is being changed and if it's already taken
    if (email && email.toLowerCase() !== admin.email) {
      const existingAdmin = await Admin.findOne({ email: email.toLowerCase() });
      if (existingAdmin && existingAdmin.admin_id !== admin_id) {
        return res.status(400).json({ message: 'Email already in use' });
      }
      admin.email = email.toLowerCase();
    }
    
    if (name) admin.name = name.trim();
    if (additional_info) {
      admin.additional_info = {
        phone: additional_info.phone || admin.additional_info?.phone || '',
        department: additional_info.department || admin.additional_info?.department || '',
        bio: additional_info.bio || admin.additional_info?.bio || '',
        address: additional_info.address || admin.additional_info?.address || ''
      };
    }
    
    admin.updated_at = new Date();
    await admin.save();
    
    const updatedAdmin = await Admin.findOne({ admin_id }, { password_hash: 0, _id: 0, __v: 0 });
    res.json({ admin: updatedAdmin, message: 'Profile updated successfully' });
  })
);

// Upload profile image
router.post(
  '/profile/upload-image',
  requireAdmin,
  upload.single('profile_image'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }
    
    const { admin_id } = req.admin;
    const admin = await Admin.findOne({ admin_id });
    if (!admin) return res.status(404).json({ message: 'Admin not found' });
    
    // Generate S3 key for profile image
    const timestamp = Date.now();
    const fileExtension = req.file.originalname.split('.').pop();
    const s3Key = `admin-profiles/${admin_id}/${timestamp}.${fileExtension}`;
    
    // Upload to S3
    const uploadResult = await uploadToS3(req.file, s3Key);
    
    if (!uploadResult.success) {
      return res.status(500).json({ 
        message: 'Failed to upload profile image',
        error: uploadResult.error 
      });
    }
    
    // Delete old profile image from S3 if exists
    if (admin.profile_image_url) {
      try {
        const oldKey = admin.profile_image_url.split('.com/')[1]?.split('?')[0];
        if (oldKey) {
          await deleteFromS3(oldKey);
        }
      } catch (error) {
        console.error('Error deleting old profile image:', error);
        // Continue even if deletion fails
      }
    }
    
    // Update admin profile with new image URL (store S3 key for presigned URL generation)
    admin.profile_image_url = uploadResult.location;
    admin.updated_at = new Date();
    await admin.save();
    
    // Generate presigned URL for immediate access (valid for 1 week - max allowed by AWS)
    const presignedResult = await generatePresignedUrl(s3Key, 604800); // 1 week (max allowed by AWS)
    const finalUrl = presignedResult.success ? presignedResult.url : admin.profile_image_url;
    
    res.json({ 
      profile_image_url: finalUrl,
      message: 'Profile image uploaded successfully' 
    });
  })
);

// Change password
router.post(
  '/change-password',
  requireAdmin,
  body('current_password').optional().isString().isLength({ min: 6 }),
  body('new_password').isString().isLength({ min: 6 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { admin_id } = req.admin;
    const { current_password, new_password } = req.body;
    const admin = await Admin.findOne({ admin_id });
    if (!admin) return res.status(404).json({ message: 'Admin not found' });
    if (current_password) {
      const ok = await bcrypt.compare(current_password, admin.password_hash);
      if (!ok) return res.status(401).json({ message: 'Current password incorrect' });
    }
    admin.password_hash = await bcrypt.hash(new_password, 10);
    admin.updated_at = new Date();
    await admin.save();
    res.json({ ok: true, message: 'Password changed successfully' });
  })
);

export default router;


