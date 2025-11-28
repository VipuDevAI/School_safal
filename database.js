const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        is_admin BOOLEAN DEFAULT FALSE,
        submitted BOOLEAN DEFAULT FALSE,
        assigned_questions JSONB DEFAULT '{}',
        session_token VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        subject VARCHAR(255) NOT NULL,
        question_text TEXT NOT NULL,
        option_a TEXT,
        option_b TEXT,
        option_c TEXT,
        option_d TEXT,
        correct_answer VARCHAR(10),
        image_url TEXT,
        passage_id INTEGER,
        passage_text TEXT,
        option_a_image TEXT,
        option_b_image TEXT,
        option_c_image TEXT,
        option_d_image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    try {
      await client.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS passage_id INTEGER`);
      await client.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS passage_text TEXT`);
      await client.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_a_image TEXT`);
      await client.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_b_image TEXT`);
      await client.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_c_image TEXT`);
      await client.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_d_image TEXT`);
    } catch (e) {}

    await client.query(`
      CREATE TABLE IF NOT EXISTS responses (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        score INTEGER DEFAULT 0,
        answers JSONB DEFAULT '{}',
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS grades (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        subject VARCHAR(255) NOT NULL,
        score INTEGER DEFAULT 0,
        percentage DECIMAL(5,2),
        graded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        value TEXT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS uploads (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        source VARCHAR(50) NOT NULL,
        question_count INTEGER DEFAULT 0,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS passages (
        id SERIAL PRIMARY KEY,
        subject VARCHAR(255) NOT NULL,
        passage_text TEXT NOT NULL,
        passage_type VARCHAR(50) DEFAULT 'prose',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    try {
      await client.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS upload_id INTEGER`);
    } catch (e) {}

    const adminCheck = await client.query(
      "SELECT * FROM users WHERE username = 'admin'"
    );
    
    if (adminCheck.rows.length === 0) {
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash('Admin123', 10);
      await client.query(
        `INSERT INTO users (username, password, display_name, is_admin) 
         VALUES ('admin', $1, 'Administrator', TRUE)`,
        [hashedPassword]
      );
      console.log('Default admin created: username=admin, password=Admin123');
    }

    const configCheck = await client.query(
      "SELECT * FROM config WHERE key = 'ExamActive'"
    );
    if (configCheck.rows.length === 0) {
      await client.query(
        "INSERT INTO config (key, value) VALUES ('ExamActive', 'TRUE')"
      );
      await client.query(
        "INSERT INTO config (key, value) VALUES ('TotalQuestionsPerSubject', '50')"
      );
      await client.query(
        "INSERT INTO config (key, value) VALUES ('ActiveSubject', 'EVS')"
      );
      await client.query(
        "INSERT INTO config (key, value) VALUES ('AdminUsers', 'admin')"
      );
    }

    console.log('Database tables created/verified successfully');
  } finally {
    client.release();
  }
}

async function getConfig(key) {
  const result = await pool.query(
    'SELECT value FROM config WHERE key = $1',
    [key]
  );
  return result.rows.length > 0 ? result.rows[0].value : null;
}

async function setConfig(key, value) {
  await pool.query(
    `INSERT INTO config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

module.exports = {
  pool,
  initDatabase,
  getConfig,
  setConfig
};
