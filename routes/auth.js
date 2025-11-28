const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool, getConfig } = require('../database');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const normalizedUsername = (username || '').toLowerCase().trim();
    
    if (!normalizedUsername) {
      return res.json({ success: false, message: 'Username required' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = $1',
      [normalizedUsername]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'User not found' });
    }

    const user = result.rows[0];
    
    let passwordMatch = false;
    if (user.password.startsWith('$2')) {
      passwordMatch = await bcrypt.compare(password, user.password);
    } else {
      passwordMatch = password === user.password;
    }

    if (!passwordMatch) {
      return res.json({ success: false, message: 'Incorrect password' });
    }

    const token = uuidv4().replace(/-/g, '');
    await pool.query(
      'UPDATE users SET session_token = $1 WHERE id = $2',
      [token, user.id]
    );

    const examActive = await getConfig('ExamActive');

    res.json({
      success: true,
      username: user.username,
      name: user.display_name || user.username,
      isAdmin: user.is_admin,
      token: token,
      examActive: examActive === 'TRUE'
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (token) {
      await pool.query(
        'UPDATE users SET session_token = NULL WHERE session_token = $1',
        [token]
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

async function getUserFromToken(token) {
  if (!token) return null;
  
  const result = await pool.query(
    'SELECT * FROM users WHERE session_token = $1',
    [token]
  );
  
  return result.rows.length > 0 ? result.rows[0] : null;
}

async function isAdminToken(token) {
  const user = await getUserFromToken(token);
  if (!user) return false;
  
  const adminUsers = await getConfig('AdminUsers');
  const admins = (adminUsers || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  
  return user.is_admin || admins.includes(user.username.toLowerCase());
}

module.exports = router;
module.exports.getUserFromToken = getUserFromToken;
module.exports.isAdminToken = isAdminToken;
