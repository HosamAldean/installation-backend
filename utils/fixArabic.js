import iconv from 'iconv-lite';

// backend/utils/fixArabic.js
export function fixArabic(str) {
    if (!str) return str;
    return Buffer.from(str, 'binary').toString('utf8');
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


