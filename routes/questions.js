const express = require('express');
const router = express.Router();
const { pool, getConfig } = require('../database');
const { getUserFromToken } = require('./auth');

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function assignPaperIfNeeded(username, subject) {
  username = (username || '').toLowerCase().trim();
  subject = (subject || '').trim();

  const userResult = await pool.query(
    'SELECT * FROM users WHERE LOWER(username) = $1',
    [username]
  );

  if (userResult.rows.length === 0) {
    throw new Error('User not found');
  }

  const user = userResult.rows[0];
  let assignedObj = user.assigned_questions || {};

  if (assignedObj[subject] && Array.isArray(assignedObj[subject])) {
    return assignedObj[subject];
  }

  const questionsResult = await pool.query(
    'SELECT id FROM questions WHERE LOWER(subject) LIKE $1',
    [`%${subject.toLowerCase()}%`]
  );

  const pool_ids = questionsResult.rows.map(q => q.id);

  const totalConfig = await getConfig('TotalQuestionsPerSubject');
  const totalNeeded = parseInt(totalConfig, 10) || 50;

  if (pool_ids.length < totalNeeded) {
    throw new Error(`Not enough questions for ${subject} (need ${totalNeeded}, have ${pool_ids.length})`);
  }

  shuffleArray(pool_ids);
  const selected = pool_ids.slice(0, totalNeeded);

  assignedObj[subject] = selected;
  
  await pool.query(
    'UPDATE users SET assigned_questions = $1 WHERE id = $2',
    [JSON.stringify(assignedObj), user.id]
  );

  return selected;
}

router.post('/get-question', async (req, res) => {
  try {
    const { token, subject, index } = req.body;

    const user = await getUserFromToken(token);
    if (!user) {
      return res.json({ error: 'Invalid session token' });
    }

    const examActive = await getConfig('ExamActive');
    if (examActive !== 'TRUE') {
      return res.json({ error: 'Exam is disabled by admin' });
    }

    const subjectName = (subject || '').trim();
    const assignedIds = await assignPaperIfNeeded(user.username, subjectName);
    const total = assignedIds.length;

    if (index < 0 || index >= total) {
      return res.json(null);
    }

    const questionId = assignedIds[index];
    const questionResult = await pool.query(
      `SELECT q.*, p.passage_text 
       FROM questions q 
       LEFT JOIN passages p ON q.passage_id = p.id 
       WHERE q.id = $1`,
      [questionId]
    );

    if (questionResult.rows.length === 0) {
      return res.json(null);
    }

    const q = questionResult.rows[0];

    res.json({
      id: q.id,
      subject: q.subject,
      question: q.question_text,
      options: [q.option_a, q.option_b, q.option_c, q.option_d],
      optionImages: [q.option_a_image || '', q.option_b_image || '', q.option_c_image || '', q.option_d_image || ''],
      total: total,
      imageUrl: q.image_url || '',
      passageId: q.passage_id,
      passageText: q.passage_text || ''
    });
  } catch (error) {
    console.error('Get question error:', error);
    res.json({ error: error.message });
  }
});

module.exports = router;
module.exports.assignPaperIfNeeded = assignPaperIfNeeded;
