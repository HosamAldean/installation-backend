// hashPasswords.js
import bcrypt from "bcrypt";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function updatePasswords() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
    });

    console.log("Connected to DB ✅");

    // 1️⃣ Update existing passwords
    const [rows] = await conn.execute("SELECT userId, password FROM InsUser");
    for (const user of rows) {
        if (!user.password.startsWith("$2b$")) {
            const hashed = await bcrypt.hash(user.password, 10);
            await conn.execute("UPDATE InsUser SET password = ? WHERE userId = ?", [
                hashed,
                user.userId,
            ]);
            console.log(`✅ Updated password for user ${user.userId}`);
        } else {
            console.log(`⏭️  User ${user.userId} already hashed`);
        }
    }

    // 2️⃣ Add new user testuser
    const username = "testuser";
    const plainPassword = "123";
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    // Check if user already exists
    const [existing] = await conn.execute("SELECT userId FROM InsUser WHERE username = ?", [username]);
    if (existing.length === 0) {
        await conn.execute(
            `INSERT INTO InsUser 
            (username, password, email, role, firstName, lastName, active, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
            [username, hashedPassword, "testuser@example.com", "user", "Test", "User"]
        );
        console.log(`✅ Added new user '${username}'`);
    } else {
        console.log(`⏭️ User '${username}' already exists`);
    }

    await conn.end();
    console.log("Done ✅");
}

updatePasswords().catch(console.error);
