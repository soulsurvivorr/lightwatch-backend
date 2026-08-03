// ============================================================
//  upload.js — general-purpose multer + Cloudinary (v2) upload
//
//  NOTE: this intentionally does NOT use multer-storage-cloudinary —
//  that package's latest release (4.0.0) peer-depends on
//  cloudinary@^1.21.0, which conflicts with the cloudinary@2.x SDK
//  used everywhere else in this project (see cloudinary.js) and
//  fails npm install with an ERESOLVE error. Instead: multer holds
//  the file in memory, and we upload the buffer to Cloudinary
//  ourselves via cloudinary.uploader.upload_stream — same result,
//  zero extra dependency, no version conflict.
//
//  This is separate from the existing base64-data-URL path used by
//  avatars/chat media (see uploadImageToCloudinary() in server.js).
//  Use THIS when a route needs a real multipart/form-data file
//  upload (an <input type="file">/FormData POST).
// ============================================================
const multer = require('multer');
const cloudinary = require('./cloudinary');

// Cloudinary's free plan caps video uploads at 100MB (images/raw files
// are capped lower, at 10MB, on their end regardless of what we allow
// here). Files over 100MB need chunked uploading (a different
// Cloudinary API call, upload_large) — not implemented here. If you
// upgrade off the free plan, raise this to match your new plan's cap.
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

// Holds the uploaded file in memory (req.file.buffer) instead of
// writing it to disk. Fine for images; for video at 100MB, be aware
// each concurrent upload holds its full file in RAM for the duration
// of the request — on a small server this is worth watching under
// real traffic. If that becomes a problem, switch to multer's
// diskStorage + streaming the file off disk instead of memoryStorage.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES }
});

// Streams a buffer (from multer's memoryStorage) up to Cloudinary and
// resolves with the standard Cloudinary upload result object
// ({ secure_url, public_id, bytes, format, ... }).
function uploadBufferToCloudinary(buffer, folder) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder, resource_type: 'auto' },
            (err, result) => {
                if (err) return reject(err);
                resolve(result);
            }
        );
        stream.end(buffer);
    });
}

module.exports = { upload, uploadBufferToCloudinary };