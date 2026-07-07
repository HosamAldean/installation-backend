// backend/routes/instSteps.js
import express from 'express';
import { sequelize, sequelize2 } from '../config/db.js';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();
// Previously unauthenticated — anyone could create/edit/delete the step
// definitions (standardTime, active flag) that drive every installation
// order's progress/at-risk calculations. The frontend (InstallationSteps.tsx)
// is already gated to manager/admin via RoleProtectedRoute — mirror that here.
router.use(authenticateToken);
router.use(authorizeRoles('manager', 'admin'));

const fixArabic = (str) => {
    if (!str || typeof str !== 'string') return str;
    try {
        const buf = Buffer.from(str, 'binary');
        const utf = buf.toString('utf8');
        if (/[اأإآبتثجحخدذرزسشصضطظعغفقكلمنهوي]/.test(utf)) return utf;
        return str;
    } catch {
        return str;
    }
};
const fixArabicFields = (row) => {
    if (!row) return row;
    const arabicFields = ['descAr'];
    arabicFields.forEach((key) => {
        if (row[key]) row[key] = fixArabic(row[key]);
    });
    return row;
};
router.get('/unit-types', async (req, res) => {
    try {
        const unitTypes = await sequelize.query(
            `SELECT unitShapeId AS id, descEn, descAr 
             FROM IIT_Petra.unitShapes`,
            { type: QueryTypes.SELECT }
        );

        const fixed = unitTypes.map(fixArabicFields);

        res.json({ success: true, data: fixed });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


// GET /api/instSteps
router.get('/', async (req, res) => {
    try {
        const steps = await sequelize2.query(
            `SELECT instStepId AS id, unitTypeId, stepName, stepNumber, description, standardTime, isActive
             FROM IIT_Petra.instSteps
             ORDER BY unitTypeId, stepNumber`,
            { type: QueryTypes.SELECT }
        );
        res.json({ success: true, data: steps });
    } catch (err) {
        console.error('❌ Error fetching steps:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/instSteps
router.post('/', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { unitTypeId, stepName, stepNumber, description, standardTime, isActive } = req.body;
        if (!unitTypeId || !stepName || !stepNumber || !standardTime) {
            await trx.rollback();
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const [result] = await sequelize2.query(
            `INSERT INTO IIT_Petra.instSteps (unitTypeId, stepName, stepNumber, description, standardTime, isActive)
             VALUES (:unitTypeId, :stepName, :stepNumber, :description, :standardTime, :isActive)`,
            {
                replacements: {
                    unitTypeId,
                    stepName,
                    stepNumber,
                    description: description || '',
                    standardTime,
                    isActive: isActive !== undefined ? isActive : 1,
                },
                type: QueryTypes.INSERT,
                transaction: trx
            }
        );

        const stepId = result; // Sequelize returns inserted ID
        await trx.commit();
        res.status(201).json({ success: true, stepId });
    } catch (err) {
        await trx.rollback();
        console.error('❌ Error adding step:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// PATCH /api/instSteps/:id
router.patch('/:id', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { id } = req.params;
        const { stepName, stepNumber, description, standardTime, isActive } = req.body;

        const updates = [];
        const replacements = { id };

        if (stepName !== undefined) { updates.push('stepName = :stepName'); replacements.stepName = stepName; }
        if (stepNumber !== undefined) { updates.push('stepNumber = :stepNumber'); replacements.stepNumber = stepNumber; }
        if (description !== undefined) { updates.push('description = :description'); replacements.description = description; }
        if (standardTime !== undefined) { updates.push('standardTime = :standardTime'); replacements.standardTime = standardTime; }
        if (isActive !== undefined) { updates.push('isActive = :isActive'); replacements.isActive = isActive; }

        if (!updates.length) {
            await trx.rollback();
            return res.status(400).json({ success: false, message: 'Nothing to update' });
        }

        await sequelize2.query(
            `UPDATE IIT_Petra.instSteps SET ${updates.join(', ')} WHERE instStepId = :id`,
            { replacements, type: QueryTypes.UPDATE, transaction: trx }
        );

        await trx.commit();
        res.json({ success: true });
    } catch (err) {
        await trx.rollback();
        console.error('❌ Error updating step:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// PATCH /api/instSteps/:id/toggle
router.patch('/:id/toggle', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { id } = req.params;

        const [step] = await sequelize2.query(
            `SELECT isActive FROM IIT_Petra.instSteps WHERE instStepId = :id`,
            { replacements: { id }, type: QueryTypes.SELECT }
        );

        if (!step) {
            await trx.rollback();
            return res.status(404).json({ success: false, message: 'Step not found' });
        }

        const newStatus = step.isActive ? 0 : 1;

        await sequelize2.query(
            `UPDATE IIT_Petra.instSteps SET isActive = :newStatus WHERE instStepId = :id`,
            { replacements: { id, newStatus }, type: QueryTypes.UPDATE, transaction: trx }
        );

        await trx.commit();
        res.json({ success: true, isActive: newStatus });
    } catch (err) {
        await trx.rollback();
        console.error('❌ Error toggling step status:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// DELETE /api/instSteps/:id
router.delete('/:id', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { id } = req.params;

        await sequelize2.query(
            `DELETE FROM IIT_Petra.instSteps WHERE instStepId = :id`,
            { replacements: { id }, type: QueryTypes.DELETE, transaction: trx }
        );

        await trx.commit();
        res.json({ success: true });
    } catch (err) {
        await trx.rollback();
        console.error('❌ Error deleting step:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

export default router;
