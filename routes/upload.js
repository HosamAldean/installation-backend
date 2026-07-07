// backend/routes/upload.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import mime from 'mime-types';
import { User } from '../models/User.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Ensure /uploads/avatars exists
const avatarsDir = path.resolve(process.cwd(), 'uploads/avatars');
fs.mkdirSync(avatarsDir, { recursive: true });

// Previously a local implementation that only checked the Authorization
// header — broke once the frontend moved to cookie-based auth (see
// AvatarUpload.tsx). Now uses the same shared, cookie-aware middleware as
// the rest of the app.
const requireAuth = authenticateToken;

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        const uniqueName = Date.now() + '-' + Math.random().toString(36).substring(2, 10) + ext;
        cb(null, uniqueName);
    }
});

const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tif', '.tiff']);
const imageMimeRegex = /^image\/(jpeg|png|gif|webp|bmp|svg\+xml|tiff)$/;

const fileFilter = (req, file, cb) => {
    const mimetype = file.mimetype;
    const ext = path.extname(file.originalname).toLowerCase();
    if (imageMimeRegex.test(mimetype) && allowedExts.has(ext)) {
        return cb(null, true);
    }
    return cb(new Error("Only valid image files are allowed"));
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 2 * 1024 * 1024 } // 2 MB
});

// POST /api/upload/upload-avatar
router.post('/upload-avatar', requireAuth, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image uploaded' });
        }

        const userId = req.user.userId;
        const user = await User.findByPk(userId);

        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        // Remove old avatar
        if (user.avatarUrl) {
            const oldPath = path.join(avatarsDir, path.basename(user.avatarUrl));
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        // Save new avatar (store only filename)
        user.avatarUrl = req.file.filename;
        await user.save();

        return res.json({
            success: true,
            message: "Avatar uploaded successfully",
            avatarUrl: user.avatarUrl
        });

    } catch (err) {
        console.error("Upload error:", err);
        return res.status(500).json({ success: false, message: 'Failed to upload avatar' });
    }
});

export default router;
