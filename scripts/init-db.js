// ------------------------------------------------------
// backend/scripts/init-db.js
// ------------------------------------------------------
// Utility script to sync models and create an initial admin user (for dev only)
import { sequelize } from '../config/db.js';
import { User } from '../models/User.js';
import bcrypt from 'bcrypt';


const run = async () => {
    try {
        await sequelize.sync({ alter: true });
        console.log('DB synced');


        const admin = await User.findOne({ where: { username: 'admin' } });
        if (!admin) {
            const hash = await bcrypt.hash('admin123', 10);
            await User.create({ username: 'admin', password: hash, role: 'admin', email: 'admin@example.com' });
            console.log('Admin user created (admin / admin123)');
        }


        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};


run();