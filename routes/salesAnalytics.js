// backend/routes/salesAnalytics.js
// Petra ERP — Sales/Executive Reporting (PH.6, "read-only capstone" per
// Migration Blueprint §07). sales_manager + admin only.
//
// The legacy app's analytics (offers.php's calcDiff()/calcDiffSteel()/
// getMarketShare()/yearlyComp()) turned out to have NO logic in PHP at
// all -- each is a bare wrapper around a MySQL stored procedure. Read
// those procedures directly (SHOW CREATE PROCEDURE) before writing this,
// per the blueprint's sign-off-gate note for these exact formulas:
//   - STP_calcDiff/STP_calcDiffSteel don't compute a report -- they
//     UPDATE offers.revDiff by parsing offerName string suffixes
//     ("-R1", "-ST-", "-AD", "-0") to infer a revision chain per offer
//     and diff quotation values across revisions. Naming-convention-
//     dependent and mutates data; deliberately not reproduced here.
//   - STP_getMarketShare's per-competitor/per-archOffice breakdown relies
//     on magic assumptions this session couldn't verify (offerName ending
//     in "-0", excluding competitorId=16, offerStatusId 3/220 specifically
//     meaning Sold/Lost -- confirmed via offerStatus, but the rest of the
//     name-parsing wasn't) -- not reproduced either.
//   - The one piece verified safe to reuse: an offer's effective value is
//     computed identically in all three procedures as
//     SUM(quotations.price) - SUM(quotations.price * qDiscountPerc/100),
//     grouped by (offerId, qChoiceNo), taking the MAX per offer. That
//     exact pattern is what OFFER_VALUE_SQL below reproduces -- confirmed
//     recurring 3x identically, not a guess.
//
// Reports here (pipeline-by-status, by-sales-person, monthly-trend) are
// this session's own straightforward aggregates over real offers/
// quotations/project data -- not a port of the legacy report pages.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sequelize2PetraErp } from '../config/db.js';

const router = express.Router();
router.use(authenticateToken, requirePermission(PERMISSIONS.PETRA_ERP_REPORTING));

// Per-offer effective value: best (max) quotation choice, price net of
// its line discount. See file header -- verified against three legacy
// stored procedures, not guessed.
const OFFER_VALUE_SQL = `
    SELECT qOfferId, MAX(sVal) AS offerValue FROM (
        SELECT quotations.offerId AS qOfferId, quotations.qChoiceNo,
               SUM(IFNULL(quotations.price, 0)) - SUM(IFNULL(quotations.price, 0) * IFNULL(quotations.qDiscountPerc, 0) / 100) AS sVal
          FROM quotations
         GROUP BY quotations.offerId, quotations.qChoiceNo
    ) t
    GROUP BY qOfferId
`;

// GET /api/sales-analytics/pipeline -- offer count + total effective value per status
router.get('/pipeline', async (req, res) => {
    const rows = await sequelize2PetraErp.query(
        `SELECT s.offerStatusId, s.offerStatusName,
                COUNT(o.offerId) AS offerCount,
                COALESCE(SUM(v.offerValue), 0) AS totalValue
           FROM offerStatus s
           LEFT JOIN offers o ON o.offerStatusId = s.offerStatusId
           LEFT JOIN (${OFFER_VALUE_SQL}) v ON v.qOfferId = o.offerId
          GROUP BY s.offerStatusId, s.offerStatusName
          ORDER BY offerCount DESC`,
        { type: QueryTypes.SELECT },
    );
    res.json({ pipeline: rows });
});

// GET /api/sales-analytics/by-sales-person -- offers, won count/value, win rate per rep
router.get('/by-sales-person', async (req, res) => {
    const rows = await sequelize2PetraErp.query(
        `SELECT o.salesPersonId, u.firstName, u.lastName,
                COUNT(o.offerId) AS offerCount,
                SUM(CASE WHEN o.offerStatusId = 3 THEN 1 ELSE 0 END) AS wonCount,
                COALESCE(SUM(CASE WHEN o.offerStatusId = 3 THEN v.offerValue ELSE 0 END), 0) AS wonValue
           FROM offers o
           LEFT JOIN InsUser u ON o.salesPersonId = u.userId
           LEFT JOIN (${OFFER_VALUE_SQL}) v ON v.qOfferId = o.offerId
          WHERE o.salesPersonId IS NOT NULL
          GROUP BY o.salesPersonId, u.firstName, u.lastName
          ORDER BY wonValue DESC`,
        { type: QueryTypes.SELECT },
    );
    res.json({ bySalesPerson: rows });
});

// GET /api/sales-analytics/monthly-trend?year= -- offer count + total value per month
router.get('/monthly-trend', async (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const rows = await sequelize2PetraErp.query(
        `SELECT MONTH(o.inquiryDate) AS month,
                COUNT(o.offerId) AS offerCount,
                COALESCE(SUM(v.offerValue), 0) AS totalValue,
                SUM(CASE WHEN o.offerStatusId = 3 THEN 1 ELSE 0 END) AS wonCount
           FROM offers o
           LEFT JOIN (${OFFER_VALUE_SQL}) v ON v.qOfferId = o.offerId
          WHERE YEAR(o.inquiryDate) = :year
          GROUP BY MONTH(o.inquiryDate)
          ORDER BY month`,
        { replacements: { year }, type: QueryTypes.SELECT },
    );
    res.json({ year, monthly: rows });
});

export default router;
