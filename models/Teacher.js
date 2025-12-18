import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const TeacherSchema = new mongoose.Schema({
  teacher_id: { type: String, default: uuidv4, index: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: { type: String, required: true },
  password_hash: { type: String, required: true },
  status: { type: String, enum: ['active','inactive'], default: 'active' },
  fcm_token: { type: String, default: null },
  created_at: { type: Date, default: Date.now }
});

export const Teacher = mongoose.model('Teacher', TeacherSchema);


