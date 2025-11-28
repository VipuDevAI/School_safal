const express = require('express');
const router = express.Router();
const { pool, getConfig } = require('../database');
const { getUserFromToken } = require('./auth');
const { assignPaperIfNeeded } = require('./questions');

function normalizeCorrect(val) {
  const s = String(val || '').trim().toUpperCase();
  if (!s) return '';
  if (['A', 'B', 'C', 'D'].includes(s)) return s;
  if (s.startsWith('OPTION A')) return 'A';
  if (s.startsWith('OPTION B')) return 'B';
  if (s.startsWith('OPTION C')) return 'C';
  if (s.startsWith('OPTION D')) return 'D';
  return s;
}

router.post('/submit', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { token, subject, answers } = req.body;

    const user = await getUserFromToken(token);
    if (!user) {
      return res.json({ success: false, message: 'Invalid session token' });
    }

    const examActive = await getConfig('ExamActive');
    if (examActive !== 'TRUE') {
      return res.json({ success: false, message: 'Exam is disabled by admin' });
    }

    const username = user.username.toLowerCase().trim();
    const subjectName = (subject || '').trim();

    await client.query('BEGIN');

    let assignedObj = user.assigned_questions || {};
    
    if (!assignedObj[subjectName] || !Array.isArray(assignedObj[subjectName])) {
      assignedObj[subjectName] = await assignPaperIfNeeded(username, subjectName);
    }

    if (!assignedObj.__meta__) assignedObj.__meta__ = {};

    const assignedIds = assignedObj[subjectName];

    const questionsResult = await client.query(
      'SELECT id, correct_answer FROM questions WHERE id = ANY($1)',
      [assignedIds]
    );

    const correctMap = {};
    questionsResult.rows.forEach(q => {
      correctMap[q.id] = normalizeCorrect(q.correct_answer);
    });

    let score = 0;
    const answersObj = answers || {};
    
    assignedIds.forEach(qid => {
      const given = String(answersObj[qid] || '').toUpperCase().trim();
      const correct = correctMap[qid] || '';
      if (given && correct && given === correct) {
        score++;
      }
    });

    await client.query(
      'INSERT INTO responses (username, subject, score, answers) VALUES ($1, $2, $3, $4)',
      [username, subjectName, score, JSON.stringify(answersObj)]
    );

    const total = assignedIds.length;
    const percentage = total > 0 ? ((score * 100.0) / total).toFixed(2) : '0.00';

    await client.query(
      'INSERT INTO grades (username, display_name, subject, score, percentage) VALUES ($1, $2, $3, $4, $5)',
      [username, user.display_name || username, subjectName, score, percentage]
    );

    assignedObj.__meta__[subjectName] = {
      submitted: true,
      submittedAt: new Date().toISOString(),
      score: score,
      total: total
    };

    await client.query(
      'UPDATE users SET assigned_questions = $1 WHERE id = $2',
      [JSON.stringify(assignedObj), user.id]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      score: score,
      total: total
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Submit exam error:', error);
    res.json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

router.post('/get-active-subject', async (req, res) => {
  try {
    const { token } = req.body;

    const user = await getUserFromToken(token);
    if (!user) {
      return res.json({ error: 'Invalid session token' });
    }

    const subject = await getConfig('ActiveSubject');
    res.json({ subject: subject || 'EVS' });
  } catch (error) {
    console.error('Get active subject error:', error);
    res.json({ error: error.message });
  }
});

module.exports = router;
