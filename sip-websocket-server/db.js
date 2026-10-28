import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';

// Initializes local SQLite database natively without external C++ bindings
const db = new DatabaseSync('./pbx_data.db');

export const initDb = () => {
  // 1. Extensions Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS extensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extension TEXT UNIQUE NOT NULL,
      auth_user TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      is_online INTEGER DEFAULT 0,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Call Logs Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT UNIQUE NOT NULL,
      caller_ext TEXT NOT NULL,
      callee_ext TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at DATETIME,
      duration_seconds INTEGER DEFAULT 0,
      formatted_duration TEXT DEFAULT '00:00'
    )
  `);

  // 3. Intercom Broadcast Logs Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS broadcast_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_ext TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default extensions
  const row = db.prepare('SELECT COUNT(*) as count FROM extensions').get();
  if (row && row.count === 0) {
    const defaultPassword = bcrypt.hashSync('123456', 10);
    const stmt = db.prepare('INSERT INTO extensions (extension, auth_user, password_hash, role) VALUES (?, ?, ?, ?)');
    stmt.run('1001', '1001', defaultPassword, 'admin');
    stmt.run('1002', '1002', defaultPassword, 'user');
    stmt.run('0774297590', '0774297590', defaultPassword, 'user');
    console.log('Seeded default PBX Extensions: 1001 (Admin), 1002, 0774297590 (Pass: 123456)');
  }
};

export default db;