// ============================================================
//  cloudinary.js — Cloudinary connection config
//
//  Used to upload image data URLs (avatars, chat media) to
//  Cloudinary instead of storing base64 strings directly in
//  MongoDB. See uploadImageToCloudinary() usages in server.js.
// ============================================================
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.warn("WARNING: Cloudinary env vars not fully set. Image uploads (avatars, chat media) will fail.");
}

module.exports = cloudinary;