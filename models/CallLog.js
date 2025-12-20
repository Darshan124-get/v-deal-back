import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const CallLogSchema = new mongoose.Schema({
  call_id: { type: String, default: uuidv4, index: true, unique: true },
  teacher_id: { type: String, index: true },
  contact_id: { type: String, index: true },
  call_status: { type: String, enum: ['Received','Not Received','Busy','Wrong Number','Call Later'], required: true },
  review_notes: { type: String },
  call_time: { type: Date },
  duration: { type: Number },
  submitted_date: { type: Date, default: Date.now },
  // Store phone and name when contact_id is null (for admin display)
  phone_number: { type: String },
  contact_name: { type: String }
});

export const CallLog = mongoose.model('CallLog', CallLogSchema);


