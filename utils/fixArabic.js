import iconv from 'iconv-lite';

// backend/utils/fixArabic.js
export function fixArabic(str) {
    if (!str) return str;
    return Buffer.from(str, 'binary').toString('utf8');
}

// Inverse of fixArabic's read-side correction -- for writing a PROPER
// Unicode string (e.g. from SQL Server, which returns correctly-decoded
// text) into a legacy MySQL text column that this codebase's Arabic data
// is conventionally stored "pre-mangled" in. MySQL's `latin1` charset is
// actually Windows-1252, not true ISO-8859-1 -- confirmed live: the read
// path (sequelize's typeCast, then this file's fixArabic()) round-trips
// existing data correctly because that data's UTF-8 bytes were originally
// decoded byte-by-byte AS cp1252 codepoints (e.g. UTF-8 byte 0x88 becomes
// U+02C6 "ˆ", cp1252's real mapping for that byte -- NOT U+0088, the raw
// identity byte value a naive Buffer('binary') round-trip would produce).
// Storing text with the naive identity mapping instead of true cp1252
// causes MySQL's server-side utf8mb4->latin1 conversion on read to
// silently drop characters whose cp1252 mapping differs from their raw
// byte value (confirmed live: an identity-mapped insert rendered as
// "ارض�?ة..." with specific letters replaced by "�?"). A handful of
// byte values (0x81, 0x8D, 0x8F, 0x90, 0x9D) have no cp1252 mapping at
// all; those fall back to the identity byte value, matching how the
// existing legacy data already stores those specific positions.
export function toLegacyArabicStorage(str) {
    if (!str) return str;
    const utf8Bytes = Buffer.from(str, 'utf8');
    let out = '';
    for (const byte of utf8Bytes) {
        const decoded = iconv.decode(Buffer.from([byte]), 'win1252');
        out += decoded === '�' ? String.fromCharCode(byte) : decoded;
    }
    return out;
}

/**
 * Fix all string fields of an object
 */
// utils/fixArabic.js
export function fixArabicFields(data) {
    if (!data) return data;

    if (typeof data === 'string') {
        // Fix garbled latin1 Arabic string
        return Buffer.from(data, 'binary').toString('utf8');
    }

    if (Array.isArray(data)) return data.map(fixArabicFields);

    if (typeof data === 'object') {
        Object.keys(data).forEach(key => {
            if (typeof data[key] === 'string') data[key] = Buffer.from(data[key], 'binary').toString('utf8');
        });
    }

    return data;
}


