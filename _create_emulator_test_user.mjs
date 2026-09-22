import { User } from './models/User.js';
import bcrypt from 'bcrypt';

const existing = await User.findOne({ where: { username: 'zztest_emulator' } });
if (existing) { await existing.destroy(); console.log('Removed pre-existing leftover test user first.'); }

const hash = await bcrypt.hash('Test1234!', 10);
const testUser = await User.create({
  username: 'zztest_emulator',
  password: hash,
  role: 'installation_employee',
  firstName: 'Emulator',
  lastName: 'Test',
  assignedEmpNo: 900001,
  assignedStore: null,
  active: true,
});
console.log('Created test user:', { userId: testUser.userId, username: testUser.username, assignedEmpNo: testUser.assignedEmpNo });
process.exit(0);
