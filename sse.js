// backend/sse.js
export const sseClients = new Set();

export const sendSseUpdate = (data) => {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(res => res.write(payload));
};
