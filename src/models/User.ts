import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  _id: string;           // Firebase UID
  phone: string;         // E.164 format e.g. "+911234567890"
  username: string;
  createdAt: Date;
  level: number;
  xp: number;
  gemDust: number;
  equippedCosmetics: {
    avatar: string;
    nameplate: string;
    banner: string;
    gemSkin: string;
  };
  stats: {
    matchesPlayed: number;
    wins: number;
    eliminations: number;
    timesPoison: number;   // How many times you poisoned someone
  };
}

const UserSchema = new Schema<IUser>(
  {
    _id: { type: String, required: true },   // Firebase UID as _id
    phone: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 20 },
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
    gemDust: { type: Number, default: 0 },
    equippedCosmetics: {
      avatar: { type: String, default: 'default' },
      nameplate: { type: String, default: 'default' },
      banner: { type: String, default: 'default' },
      gemSkin: { type: String, default: 'default' },
    },
    stats: {
      matchesPlayed: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      eliminations: { type: Number, default: 0 },
      timesPoison: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
    _id: false,  // We're using Firebase UID as _id, not auto ObjectId
  }
);

export const User = mongoose.model<IUser>('User', UserSchema);
