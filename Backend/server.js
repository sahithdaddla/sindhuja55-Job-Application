const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = 3044;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// PostgreSQL connection
const pool = new Pool({
    user: 'postgres',
    host: 'postgres',
    database: 'job_application_db',
    password: 'admin123',
    port: 5432,
});

// File upload configuration
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /pdf|jpeg|jpg|png/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only PDF, JPG, and PNG files are allowed!'));
    }
});

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// API Endpoints

// Submit job application
app.post('/api/applications', upload.fields([
    { name: 'ssc', maxCount: 1 },
    { name: 'inter', maxCount: 1 },
    { name: 'graduation', maxCount: 1 },
    { name: 'postgrad', maxCount: 1 },
    { name: 'relieving', maxCount: 1 }
]), async (req, res) => {
    try {
        const {
            role, location, fullName, email, phone, gender,
            fatherName, fatherPhone, employmentStatus,
            companyName, companyLocation, experience
        } = req.body;

        // Validate required fields
        if (!role || !location || !fullName || !email || !phone || !gender || !fatherName || !fatherPhone) {
            return res.status(400).json({ error: 'All required fields must be provided' });
        }

        // Check for duplicate application (same email and phone on the same day)
        const currentDate = new Date().toISOString().split('T')[0];
        const duplicateCheck = await pool.query(
            `SELECT id FROM applications 
             WHERE personal_info->>'email' = $1 
             AND personal_info->>'phone' = $2 
             AND DATE(created_at) = $3`,
            [email, phone, currentDate]
        );

        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Duplicate application detected for today' });
        }

        // Prepare document paths
        const documents = {};
        ['ssc', 'inter', 'graduation', 'postgrad', 'relieving'].forEach(field => {
            if (req.files[field]) {
                documents[field] = {
                    name: req.files[field][0].originalname,
                    path: req.files[field][0].path,
                    type: req.files[field][0].mimetype,
                    size: req.files[field][0].size
                };
            }
        });

        // Prepare employment history
        const employmentHistory = employmentStatus === 'experienced' ? {
            companyName,
            location: companyLocation,
            experience
        } : null;

        // Insert into database
        const result = await pool.query(
            `INSERT INTO applications (
                role, location, personal_info, employment_status, 
                employment_history, documents, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id`,
            [
                role,
                location,
                { fullName, email, phone, gender, fatherName, fatherPhone },
                employmentStatus,
                employmentHistory,
                documents,
                'pending'
            ]
        );

        res.status(201).json({ id: result.rows[0].id, message: 'Application submitted successfully' });
    } catch (error) {
        console.error('Error submitting application:', error);
        res.status(500).json({ error: 'Failed to submit application' });
    }
});

// Get all applications
app.get('/api/applications', async (req, res) => {
    try {
        const { search = '', status = 'all' } = req.query;
        let query = `SELECT * FROM applications`;
        let values = [];
        
        if (search || status !== 'all') {
            query += ` WHERE `;
            const conditions = [];
            
            if (search) {
                conditions.push(
                    `(personal_info->>'fullName' ILIKE $1 
                    OR personal_info->>'email' ILIKE $1 
                    OR role ILIKE $1)`
                );
                values.push(`%${search}%`);
            }
            
            if (status !== 'all') {
                conditions.push(`status = $${values.length + 1}`);
                values.push(status);
            }
            
            query += conditions.join(' AND ');
        }

        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching applications:', error);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

// Get single application
app.get('/api/applications/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM applications WHERE id = $1',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching application:', error);
        res.status(500).json({ error: 'Failed to fetch application' });
    }
});

// Update application status
app.put('/api/applications/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const result = await pool.query(
            'UPDATE applications SET status = $1 WHERE id = $2 RETURNING *',
            [status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        res.json({ message: `Application ${status} successfully`, application: result.rows[0] });
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Upload offer letter
app.post('/api/applications/:id/offer-letter', upload.single('offerLetter'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const offerLetter = {
            name: req.file.originalname,
            path: req.file.path,
            type: req.file.mimetype,
            size: req.file.size
        };

        const result = await pool.query(
            'UPDATE applications SET offer_letter = $1 WHERE id = $2 RETURNING *',
            [offerLetter, req.params.id]
        );

        if (result.rows.length === 0) {
            // Clean up uploaded file if update fails
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Application not found' });
        }

        res.json({ message: 'Offer letter uploaded successfully', application: result.rows[0] });
    } catch (error) {
        console.error('Error uploading offer letter:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Failed to upload offer letter' });
    }
});

// Remove offer letter
app.delete('/api/applications/:id/offer-letter', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT offer_letter FROM applications WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        const offerLetter = result.rows[0].offer_letter;
        if (offerLetter && offerLetter.path && fs.existsSync(offerLetter.path)) {
            fs.unlinkSync(offerLetter.path);
        }

        await pool.query(
            'UPDATE applications SET offer_letter = NULL WHERE id = $1',
            [req.params.id]
        );

        res.json({ message: 'Offer letter removed successfully' });
    } catch (error) {
        console.error('Error removing offer letter:', error);
        res.status(500).json({ error: 'Failed to remove offer letter' });
    }
});

// Clear all records
app.delete('/api/applications', async (req, res) => {
    try {
        // Delete all uploaded files
        const result = await pool.query('SELECT documents, offer_letter FROM applications');
        result.rows.forEach(row => {
            Object.values(row.documents || {}).forEach(doc => {
                if (doc.path && fs.existsSync(doc.path)) {
                    fs.unlinkSync(doc.path);
                }
            });
            if (row.offer_letter && row.offer_letter.path && fs.existsSync(row.offer_letter.path)) {
                fs.unlinkSync(row.offer_letter.path);
            }
        });

        // Clear database
        await pool.query('DELETE FROM applications');
        res.json({ message: 'All records cleared successfully' });
    } catch (error) {
        console.error('Error clearing records:', error);
        res.status(500).json({ error: 'Failed to clear records' });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running at http://13.61.11.89:${port}`);
});