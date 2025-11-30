const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { parse } = require('csv-parse/sync');
const mammoth = require('mammoth');
const { pool, getConfig, setConfig } = require('../database');

function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

function extractGid(url) {
  const match = url.match(/gid=([0-9]+)/);
  return match ? match[1] : '0';
}

function parseGoogleDriveUrl(url) {
  if (!url) return '';
  url = url.trim();
  
  if (!url.match(/^https?:\/\/.*/)) return url;
  
  let id = '';
  let m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) id = m[1];
  if (url.indexOf('open?id=') !== -1) id = url.split('open?id=')[1].split('&')[0];
  if (url.indexOf('id=') !== -1 && !id) id = url.split('id=')[1].split('&')[0];
  
  if (id) return "https://drive.google.com/uc?export=view&id=" + id;
  return url;
}

function normalizeCorrectAnswer(val) {
  const s = String(val || '').trim().toUpperCase();
  if (!s) return '';
  if (['A', 'B', 'C', 'D'].includes(s)) return s;
  if (s.startsWith('OPTION A') || s === 'A)' || s.includes('(A)')) return 'A';
  if (s.startsWith('OPTION B') || s === 'B)' || s.includes('(B)')) return 'B';
  if (s.startsWith('OPTION C') || s === 'C)' || s.includes('(C)')) return 'C';
  if (s.startsWith('OPTION D') || s === 'D)' || s.includes('(D)')) return 'D';
  return s;
}
const { isAdminToken, getUserFromToken } = require('./auth');

async function requireAdmin(req, res, next) {
  const token = req.body.token || req.query.token;
  const isAdmin = await isAdminToken(token);
  
  if (!isAdmin) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  
  next();
}

router.post('/create-user', requireAdmin, async (req, res) => {
  try {
    const { username, password, displayName, isAdmin } = req.body;
    const normalizedUsername = (username || '').toLowerCase().trim();

    if (!normalizedUsername) {
      return res.json({ success: false, message: 'Username required' });
    }

    const existingUser = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = $1',
      [normalizedUsername]
    );

    if (existingUser.rows.length > 0) {
      return res.json({ success: false, message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    await pool.query(
      `INSERT INTO users (username, password, display_name, is_admin) 
       VALUES ($1, $2, $3, $4)`,
      [normalizedUsername, hashedPassword, displayName || normalizedUsername, isAdmin || false]
    );

    if (isAdmin) {
      const existing = await getConfig('AdminUsers') || '';
      const list = existing ? existing.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
      if (!list.includes(normalizedUsername)) {
        list.push(normalizedUsername);
        await setConfig('AdminUsers', list.join(','));
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Create user error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/bulk-create-users', requireAdmin, async (req, res) => {
  try {
    const { csvText, passwordPrefix } = req.body;
    const results = [];

    let rows;
    try {
      rows = parse(csvText, { skip_empty_lines: true, relax_column_count: true });
    } catch (e) {
      // Fallback: split by newline and comma
      rows = csvText.split('\n').map(line => line.split(','));
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue;

      // Accept ANY format for username, display name, and password
      // Convert to string first to handle numbers
      let username = String(row[0] || '').trim().toLowerCase();
      let displayName = row[1] ? String(row[1]).trim() : username;
      let password = row[2] ? String(row[2]).trim() : (passwordPrefix || 'safal') + (i + 1);

      // Skip empty usernames
      if (!username) continue;

      try {
        const existing = await pool.query(
          'SELECT * FROM users WHERE LOWER(username) = $1',
          [username]
        );

        if (existing.rows.length > 0) {
          results.push([username, 'ERROR: User already exists']);
          continue;
        }

        // Hash password (works with any string including numbers)
        const hashedPassword = await bcrypt.hash(String(password), 10);
        await pool.query(
          `INSERT INTO users (username, password, display_name, is_admin) 
           VALUES ($1, $2, $3, FALSE)`,
          [username, hashedPassword, displayName]
        );

        results.push([username, 'OK']);
      } catch (e) {
        results.push([username, 'ERROR: ' + e.message]);
      }
    }

    const createdCount = results.filter(r => r[1] === 'OK').length;
    res.json({ success: true, results, created: createdCount });
  } catch (error) {
    console.error('Bulk create users error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/upload-questions', requireAdmin, async (req, res) => {
  try {
    const { csvText } = req.body;
    let added = 0;

    let rows;
    try {
      rows = parse(csvText, { skip_empty_lines: true, relax_column_count: true });
    } catch (e) {
      rows = csvText.split('\n').map(line => line.split(','));
    }

    for (const row of rows) {
      if (!row[0]) continue;

      const subject = (row[0] || '').trim();
      const questionText = (row[1] || '').trim();
      const optionA = (row[2] || '').trim();
      const optionB = (row[3] || '').trim();
      const optionC = (row[4] || '').trim();
      const optionD = (row[5] || '').trim();
      const correct = (row[6] || '').trim();
      const imageUrl = (row[7] || '').trim();

      if (!questionText) continue;

      await pool.query(
        `INSERT INTO questions (subject, question_text, option_a, option_b, option_c, option_d, correct_answer, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [subject, questionText, optionA, optionB, optionC, optionD, correct, imageUrl]
      );

      added++;
    }

    res.json({ success: true, added });
  } catch (error) {
    console.error('Upload questions error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/upload-word-questions', requireAdmin, async (req, res) => {
  try {
    const { wordBase64, subject, filename } = req.body;
    
    if (!wordBase64 || !subject) {
      return res.json({ success: false, message: 'Word file and subject required' });
    }

    const buffer = Buffer.from(wordBase64, 'base64');
    const result = await mammoth.convertToHtml({ buffer }, {
      convertImage: mammoth.images.imgElement(function(image) {
        return image.read("base64").then(function(imageBuffer) {
          return { src: "data:" + image.contentType + ";base64," + imageBuffer };
        });
      })
    });
    
    const html = result.value;
    let added = 0;
    let passageCount = 0;

    // Split by paragraphs and clean - keep HTML for images
    const rawBlocks = html.split(/<p[^>]*>/).map(b => b.replace(/<\/p>/g, '').trim()).filter(b => b);
    
    // Build array of content items with text and images
    // Track current instruction (## prefix) and passage (@@ prefix)
    let contentItems = [];
    let currentInstruction = null;
    let currentPassage = null;
    let currentPassageId = null;
    let collectingPassage = false;
    let pendingImage = null; // Track standalone images to attach to next question
    
    for (let i = 0; i < rawBlocks.length; i++) {
      const block = rawBlocks[i];
      const plainText = block.replace(/<[^>]+>/g, '').trim();
      // Extract ALL images from block (there might be multiple)
      const imgMatches = block.match(/<img[^>]+src="([^"]+)"[^>]*>/gi) || [];
      const imgSrcs = imgMatches.map(m => {
        const srcMatch = m.match(/src="([^"]+)"/i);
        return srcMatch ? srcMatch[1] : null;
      }).filter(s => s);
      
      const firstImage = imgSrcs[0] || null;
      
      // If this block is ONLY an image (no text), save it to attach to next question
      if (!plainText && firstImage) {
        pendingImage = firstImage;
        continue;
      }
      
      // Skip empty blocks
      if (!plainText && !firstImage) continue;
      
      // Check for INSTRUCTION marker (## prefix)
      if (plainText.startsWith('##')) {
        currentInstruction = plainText.replace(/^##\s*/, '').trim();
        collectingPassage = false;
        currentPassage = null;
        currentPassageId = null;
        continue;
      }
      
      // Check for PASSAGE/POEM marker (@@ prefix)
      if (plainText.startsWith('@@')) {
        passageCount++;
        currentPassageId = passageCount;
        currentPassage = '';
        collectingPassage = true;
        // Store passage/poem title as instruction
        const passageTitle = plainText.replace(/^@@\s*/, '').trim();
        currentInstruction = passageTitle;
        continue;
      }
      
      // Skip document headers and metadata
      const isDocHeader = plainText.match(/^SAFAL\s*[-–]/i) ||
                          plainText.toLowerCase().includes('mock question paper') ||
                          plainText.toLowerCase().includes('question paper') ||
                          plainText.match(/^MARKS\s*:/i) ||
                          plainText.match(/^ENGLISH$/i) ||
                          plainText.match(/^MATHEMATICS$/i) ||
                          plainText.match(/^EVS$/i) ||
                          plainText.match(/^MARKS\s*:\s*\d+/i);
      
      if (isDocHeader) {
        continue;
      }
      
      // Skip Roman numeral section headers (I., II., III., IV., etc.) - these are captured by @@
      const isRomanHeader = plainText.match(/^[IVX]+\.\s+/i);
      if (isRomanHeader) {
        continue;
      }
      
      // Skip other section headers
      const isSectionHeader = plainText.match(/^Section\s*[A-Z]/i) ||
                              plainText.match(/^Part\s*[IVX\d]/i) ||
                              plainText.toLowerCase().includes('multiple choice');
      
      if (isSectionHeader && plainText.length < 100) {
        continue;
      }
      
      // Check if this is an Answer line
      const isAnswerLine = plainText.match(/^Answer\s*:\s*[A-D]/i);
      
      // Check if this looks like a numbered question (including blanks at start)
      const isNumberedQuestion = plainText.match(/^(?:Q?\s*)?(\d+)[\.\)]\s*.+/i) || 
                                  plainText.match(/^(?:Q?\s*)?(\d+)[\.\)]\s*_+/i);
      
      // If collecting passage and this is passage content (not a question or answer)
      if (collectingPassage && !isAnswerLine && !isNumberedQuestion) {
        // Check if this looks like an option (starts with A), B), etc or is very short like a fraction)
        const looksLikeOption = plainText.match(/^[A-D][\.\)]/i) || 
                                 plainText.match(/^[a-d][\.\)]/i) ||
                                 (plainText.length < 20);
        
        if (!looksLikeOption && plainText.length > 20) {
          currentPassage += plainText + '\n\n';
          continue;
        }
      }
      
      // Stop collecting passage when we hit a numbered question
      if (isNumberedQuestion) {
        collectingPassage = false;
      }
      
      // Use pending image (from standalone image block before this text) if no image in current block
      const itemImage = firstImage || pendingImage;
      
      contentItems.push({
        text: plainText,
        html: block,
        image: itemImage,
        allImages: imgSrcs, // Store all images for option images
        passageText: currentPassage ? currentPassage.trim() : null,
        passageId: currentPassageId,
        instructionText: currentInstruction
      });
      
      // Clear pending image after attaching to a content item
      if (pendingImage && !firstImage) {
        pendingImage = null;
      }
    }
    
    // IMPROVED PARSER: Use numbered questions as delimiters
    // Format: "1. Question text" or "1) Question text" followed by 4 options, then "Answer: X"
    
    // First, find all question start positions (numbered items)
    let questionStarts = [];
    for (let i = 0; i < contentItems.length; i++) {
      const text = contentItems[i].text;
      // Match: 1. or 1) or Q1. or Q1) at start of line (including blanks like "1. _____ is the capital")
      // Also match questions starting immediately with blank: "1. _______"
      if (text.match(/^(?:Q?\s*)?(\d+)[\.\)]\s*.+/i) || text.match(/^(?:Q?\s*)?(\d+)[\.\)]\s*_/i)) {
        questionStarts.push(i);
      }
    }
    
    // If no numbered questions found, fall back to Answer-based detection
    if (questionStarts.length === 0) {
      // Fallback: Find questions by looking for "Answer: X" pattern
      for (let i = 0; i < contentItems.length; i++) {
        const item = contentItems[i];
        const answerMatch = item.text.match(/^Answer\s*:\s*([A-D])/i);
        
        if (answerMatch) {
          const correctAnswer = answerMatch[1].toUpperCase();
          
          // Look backwards for 4 options + 1 question
          let optionItems = [];
          let questionItems = [];
          let j = i - 1;
          
          while (j >= 0 && optionItems.length < 4) {
            const prevItem = contentItems[j];
            if (prevItem.text.toLowerCase().includes('multiple choice') ||
                prevItem.text.toLowerCase().includes('answer key') ||
                prevItem.text.match(/^Answer\s*:/i)) {
              j--;
              continue;
            }
            optionItems.unshift(prevItem);
            j--;
          }
          
          if (optionItems.length >= 5) {
            questionItems = optionItems.slice(0, optionItems.length - 4);
            optionItems = optionItems.slice(-4);
          } else if (optionItems.length >= 4) {
            while (j >= 0 && questionItems.length === 0) {
              const prevItem = contentItems[j];
              if (prevItem.text && prevItem.text.length > 10 && !prevItem.text.match(/^Answer\s*:/i)) {
                questionItems.unshift(prevItem);
                break;
              }
              j--;
            }
          }
          
          if (questionItems.length > 0 && optionItems.length >= 4) {
            let questionText = questionItems.map(q => q.text).join(' ').trim();
            // Remove question number but preserve blanks (underscores)
            questionText = questionText.replace(/^\d+[\.\)]\s?/, '').trim();
            // Ensure blanks are preserved (convert multiple underscores to proper blank display)
            questionText = questionText.replace(/_+/g, match => match.length >= 3 ? '_______' : match);
            let questionImage = questionItems.find(q => q.image)?.image || '';
            
            // Clean options - handle fractions and special characters
            let optionA = optionItems[0].text.replace(/^[aA][\.\)]\s*/, '').trim();
            let optionB = optionItems[1].text.replace(/^[bB][\.\)]\s*/, '').trim();
            let optionC = optionItems[2].text.replace(/^[cC][\.\)]\s*/, '').trim();
            let optionD = optionItems[3].text.replace(/^[dD][\.\)]\s*/, '').trim();
            
            // Handle image-only options
            if (!optionA && optionItems[0].image) optionA = '[Image]';
            if (!optionB && optionItems[1].image) optionB = '[Image]';
            if (!optionC && optionItems[2].image) optionC = '[Image]';
            if (!optionD && optionItems[3].image) optionD = '[Image]';
            
            const imageUrl = questionImage || optionItems.find(o => o.image)?.image || '';
            
            // Get passage and instruction from question items (they inherit from context)
            const passageText = questionItems[0].passageText || item.passageText || null;
            const passageId = questionItems[0].passageId || item.passageId || null;
            const instructionText = questionItems[0].instructionText || item.instructionText || null;
            
            // Check if we have valid options (text or image) - accept fractions like 1/2
            const hasValidOptions = (optionA && optionA !== '[Option]') || 
                                    (optionB && optionB !== '[Option]') || 
                                    optionItems[0].image || optionItems[1].image;
            
            if (questionText && hasValidOptions) {
              await pool.query(
                `INSERT INTO questions (subject, question_text, option_a, option_b, option_c, option_d, correct_answer, image_url, passage_id, passage_text, instruction_text)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [subject, questionText, optionA || '[Option]', optionB || '[Option]', optionC || '[Option]', optionD || '[Option]', correctAnswer, imageUrl, passageId, passageText, instructionText]
              );
              added++;
            }
          }
        }
      }
    } else {
      // NUMBERED QUESTION PARSING
      // For each numbered question, find content until next question or Answer line
      for (let q = 0; q < questionStarts.length; q++) {
        const startIdx = questionStarts[q];
        const endIdx = (q + 1 < questionStarts.length) ? questionStarts[q + 1] : contentItems.length;
        
        // Get all items for this question
        const qItems = contentItems.slice(startIdx, endIdx);
        
        // Find Answer line
        let answerIdx = -1;
        let correctAnswer = '';
        for (let a = 0; a < qItems.length; a++) {
          const answerMatch = qItems[a].text.match(/^Answer\s*:\s*([A-D])/i);
          if (answerMatch) {
            answerIdx = a;
            correctAnswer = answerMatch[1].toUpperCase();
            break;
          }
        }
        
        if (answerIdx === -1 || answerIdx < 5) continue; // Need at least question + 4 options + answer
        
        // First item is the question
        const questionItem = qItems[0];
        // Remove question number but preserve blanks (underscores) at start
        let questionText = questionItem.text.replace(/^(?:Q?\s*)?\d+[\.\)]\s?/i, '').trim();
        // Ensure blanks are preserved (convert multiple underscores to proper blank display)
        questionText = questionText.replace(/_+/g, match => match.length >= 3 ? '_______' : match);
        
        // IMPROVED: Collect ALL images from entire question block (question to answer)
        // This catches standalone images between question text and options
        let allBlockImages = [];
        for (let bi = 0; bi < answerIdx; bi++) {
          if (qItems[bi].image) {
            allBlockImages.push(qItems[bi].image);
          }
          // Also check allImages array for multiple images in one block
          if (qItems[bi].allImages && qItems[bi].allImages.length > 0) {
            allBlockImages = allBlockImages.concat(qItems[bi].allImages);
          }
        }
        // Remove duplicates
        allBlockImages = [...new Set(allBlockImages)];
        
        let questionImage = questionItem.image || (allBlockImages.length > 0 ? allBlockImages[0] : '');
        
        // Items before Answer line (excluding question) are options
        // Last 4 items before Answer are the options
        const optionItems = qItems.slice(Math.max(1, answerIdx - 4), answerIdx);
        
        if (optionItems.length < 4) continue;
        
        // Take last 4 as options
        const opts = optionItems.slice(-4);
        
        // Clean option text (remove a), b), etc. if present)
        // Also handle fractions and special Unicode characters
        let optionA = opts[0].text.replace(/^[aA][\.\)]\s*/, '').trim();
        let optionB = opts[1].text.replace(/^[bB][\.\)]\s*/, '').trim();
        let optionC = opts[2].text.replace(/^[cC][\.\)]\s*/, '').trim();
        let optionD = opts[3].text.replace(/^[dD][\.\)]\s*/, '').trim();
        
        // If option is empty but has image, mark as image option
        const optAImg = opts[0].image || '';
        const optBImg = opts[1].image || '';
        const optCImg = opts[2].image || '';
        const optDImg = opts[3].image || '';
        
        if (!optionA && optAImg) optionA = '[Image]';
        if (!optionB && optBImg) optionB = '[Image]';
        if (!optionC && optCImg) optionC = '[Image]';
        if (!optionD && optDImg) optionD = '[Image]';
        
        // Get images - use collected block images first, then option images
        const imageUrl = questionImage || optAImg || optBImg || optCImg || optDImg || '';
        
        // Get passage and instruction info
        const passageText = questionItem.passageText || null;
        const passageId = questionItem.passageId || null;
        const instructionText = questionItem.instructionText || null;
        
        // Insert question if we have text and at least some options (text or image)
        // Accept any option including fractions, numbers, single characters
        const hasOptions = (optionA && optionA !== '[Option A]') || 
                           (optionB && optionB !== '[Option B]') || 
                           optAImg || optBImg;
        
        if (questionText && hasOptions) {
          await pool.query(
            `INSERT INTO questions (subject, question_text, option_a, option_b, option_c, option_d, correct_answer, image_url, passage_id, passage_text, instruction_text)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [subject, questionText, optionA || '[Option A]', optionB || '[Option B]', optionC || '[Option C]', optionD || '[Option D]', correctAnswer, imageUrl, passageId, passageText, instructionText]
          );
          added++;
        }
      }
    }

    if (added > 0) {
      const docName = filename || 'Word Document';
      const uploadResult = await pool.query(
        `INSERT INTO uploads (filename, subject, source, question_count) VALUES ($1, $2, $3, $4) RETURNING id`,
        [docName, subject, 'word', added]
      );
      const uploadId = uploadResult.rows[0].id;
      await pool.query(
        `UPDATE questions SET upload_id = $1 WHERE upload_id IS NULL AND subject = $2`,
        [uploadId, subject]
      );
    }

    res.json({ success: true, added, passages: passageCount });
  } catch (error) {
    console.error('Upload Word questions error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/import-google-sheet', requireAdmin, async (req, res) => {
  try {
    const { sheetUrl } = req.body;
    
    if (!sheetUrl) {
      return res.json({ success: false, message: 'Sheet URL required' });
    }

    const sheetId = extractSheetId(sheetUrl);
    if (!sheetId) {
      return res.json({ success: false, message: 'Invalid Google Sheet URL. Please use a valid Google Sheets link.' });
    }

    const gid = extractGid(sheetUrl);
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

    const response = await fetch(csvUrl);
    if (!response.ok) {
      return res.json({ 
        success: false, 
        message: 'Could not fetch sheet. Make sure the sheet is published to web or shared as "Anyone with the link".' 
      });
    }

    const csvText = await response.text();
    let added = 0;
    let skipped = 0;

    let rows;
    try {
      rows = parse(csvText, { skip_empty_lines: true, relax_column_count: true });
    } catch (e) {
      rows = csvText.split('\n').map(line => line.split(','));
    }

    const header = rows[0] || [];
    const headerLower = header.map(h => (h || '').toString().toLowerCase());
    
    let isGoogleFormFormat = headerLower.some(h => h.includes('timestamp'));
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      
      if (i === 0 && (headerLower.includes('timestamp') || headerLower.some(h => h.includes('subject')))) {
        continue;
      }

      if (!row[0] && !row[1]) continue;

      let subject, questionText, optionA, optionB, optionC, optionD, correct, imageUrl;

      if (isGoogleFormFormat) {
        subject = (row[1] || '').trim();
        questionText = (row[2] || '').trim();
        imageUrl = parseGoogleDriveUrl(row[3] || '');
        optionA = (row[4] || '').trim().replace(/^[A-D]\)\s*/i, '');
        optionB = (row[5] || '').trim().replace(/^[A-D]\)\s*/i, '');
        optionC = (row[6] || '').trim().replace(/^[A-D]\)\s*/i, '');
        optionD = (row[7] || '').trim().replace(/^[A-D]\)\s*/i, '');
        correct = normalizeCorrectAnswer(row[8] || '');
      } else {
        subject = (row[0] || '').trim();
        questionText = (row[1] || '').trim();
        optionA = (row[2] || '').trim();
        optionB = (row[3] || '').trim();
        optionC = (row[4] || '').trim();
        optionD = (row[5] || '').trim();
        correct = normalizeCorrectAnswer(row[6] || '');
        imageUrl = parseGoogleDriveUrl(row[7] || '');
      }

      if (!questionText) {
        skipped++;
        continue;
      }

      await pool.query(
        `INSERT INTO questions (subject, question_text, option_a, option_b, option_c, option_d, correct_answer, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [subject, questionText, optionA, optionB, optionC, optionD, correct, imageUrl]
      );

      added++;
    }

    if (added > 0) {
      const uploadResult = await pool.query(
        `INSERT INTO uploads (filename, subject, source, question_count) VALUES ($1, $2, $3, $4) RETURNING id`,
        ['Google Sheet', 'Mixed', 'sheet', added]
      );
      const uploadId = uploadResult.rows[0].id;
      await pool.query(
        `UPDATE questions SET upload_id = $1 WHERE upload_id IS NULL`,
        [uploadId]
      );
    }

    res.json({ success: true, added, skipped });
  } catch (error) {
    console.error('Import Google Sheet error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/set-exam-active', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    await setConfig('ExamActive', active ? 'TRUE' : 'FALSE');
    res.json({ success: true });
  } catch (error) {
    console.error('Set exam active error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/set-total-questions', requireAdmin, async (req, res) => {
  try {
    const { total } = req.body;
    const num = parseInt(total, 10);
    
    if (!num || num < 1) {
      return res.json({ success: false, message: 'Invalid number' });
    }

    await setConfig('TotalQuestionsPerSubject', String(num));
    res.json({ success: true });
  } catch (error) {
    console.error('Set total questions error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/set-active-subject', requireAdmin, async (req, res) => {
  try {
    const { subject } = req.body;
    const subjectName = (subject || '').trim();

    if (!subjectName) {
      return res.json({ success: false, message: 'Subject required' });
    }

    await setConfig('ActiveSubject', subjectName);
    res.json({ success: true, activeSubject: subjectName });
  } catch (error) {
    console.error('Set active subject error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-summary', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT submitted_at as timestamp, username, subject, score FROM responses ORDER BY submitted_at DESC'
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get summary error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/export-csv', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM responses ORDER BY submitted_at DESC'
    );

    const headers = ['Timestamp', 'Username', 'Subject', 'Score', 'Answers'];
    const rows = result.rows.map(row => [
      row.submitted_at,
      row.username,
      row.subject,
      row.score,
      JSON.stringify(row.answers)
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => {
        if (cell === null || cell === undefined) return '""';
        const s = String(cell).replace(/"/g, '""');
        return `"${s}"`;
      }).join(','))
      .join('\n');

    res.json({ success: true, csv });
  } catch (error) {
    console.error('Export CSV error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-config', async (req, res) => {
  try {
    const { token, key } = req.body;
    
    const user = await getUserFromToken(token);
    if (!user) {
      return res.json({ error: 'Invalid session token' });
    }

    const value = await getConfig(key);
    res.json({ value });
  } catch (error) {
    console.error('Get config error:', error);
    res.json({ error: error.message });
  }
});

router.post('/get-users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('Get users error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/delete-user', requireAdmin, async (req, res) => {
  try {
    const { userId, username } = req.body;
    
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1 OR LOWER(username) = $2',
      [userId || 0, (username || '').toLowerCase()]
    );
    
    if (userResult.rows.length === 0) {
      return res.json({ success: false, message: 'User not found' });
    }
    
    const user = userResult.rows[0];
    if (user.is_admin) {
      return res.json({ success: false, message: 'Cannot delete admin users' });
    }
    
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    await pool.query('DELETE FROM responses WHERE LOWER(username) = $1', [user.username.toLowerCase()]);
    await pool.query('DELETE FROM grades WHERE LOWER(username) = $1', [user.username.toLowerCase()]);
    
    res.json({ success: true, deleted: user.username });
  } catch (error) {
    console.error('Delete user error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/delete-all-students', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM users WHERE is_admin = FALSE RETURNING username');
    const deleted = result.rows.length;
    
    if (deleted > 0) {
      await pool.query('DELETE FROM responses');
      await pool.query('DELETE FROM grades');
    }
    
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Delete all students error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-uploads', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, filename, subject, source, question_count, uploaded_at FROM uploads ORDER BY uploaded_at DESC'
    );
    res.json({ success: true, uploads: result.rows });
  } catch (error) {
    console.error('Get uploads error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/delete-upload', requireAdmin, async (req, res) => {
  try {
    const { uploadId } = req.body;
    
    if (!uploadId) {
      return res.json({ success: false, message: 'Upload ID required' });
    }
    
    const uploadResult = await pool.query('SELECT * FROM uploads WHERE id = $1', [uploadId]);
    if (uploadResult.rows.length === 0) {
      return res.json({ success: false, message: 'Upload not found' });
    }
    
    const upload = uploadResult.rows[0];
    
    await pool.query('DELETE FROM questions WHERE upload_id = $1', [uploadId]);
    await pool.query('DELETE FROM uploads WHERE id = $1', [uploadId]);
    
    res.json({ 
      success: true, 
      message: `Deleted "${upload.filename}" (${upload.question_count} questions)` 
    });
  } catch (error) {
    console.error('Delete upload error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-question-count', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT subject, COUNT(*) as count FROM questions GROUP BY subject ORDER BY subject'
    );
    
    const passageResult = await pool.query('SELECT COUNT(*) as count FROM passages');
    
    res.json({ 
      success: true, 
      counts: result.rows,
      passageCount: parseInt(passageResult.rows[0].count) || 0
    });
  } catch (error) {
    console.error('Get question count error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/clear-questions', requireAdmin, async (req, res) => {
  try {
    const { subject } = req.body;
    
    if (subject && subject !== 'all') {
      await pool.query('DELETE FROM questions WHERE subject = $1', [subject]);
      await pool.query('DELETE FROM uploads WHERE subject = $1', [subject]);
      res.json({ success: true, message: `Cleared all ${subject} questions` });
    } else {
      await pool.query('DELETE FROM questions');
      await pool.query('DELETE FROM passages');
      await pool.query('DELETE FROM uploads');
      res.json({ success: true, message: 'Cleared all questions and passages' });
    }
  } catch (error) {
    console.error('Clear questions error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-result-details', requireAdmin, async (req, res) => {
  try {
    const { username, subject } = req.body;
    
    const userResult = await pool.query(
      'SELECT assigned_questions FROM users WHERE LOWER(username) = $1',
      [username.toLowerCase()]
    );
    
    const responseResult = await pool.query(
      'SELECT * FROM responses WHERE LOWER(username) = $1 AND subject = $2 ORDER BY submitted_at DESC LIMIT 1',
      [username.toLowerCase(), subject]
    );
    
    if (responseResult.rows.length === 0) {
      return res.json({ success: false, message: 'Response not found' });
    }
    
    const response = responseResult.rows[0];
    const studentAnswers = typeof response.answers === 'string' 
      ? JSON.parse(response.answers) 
      : (response.answers || {});
    
    let questionIds = [];
    if (userResult.rows.length > 0 && userResult.rows[0].assigned_questions) {
      const assignedObj = typeof userResult.rows[0].assigned_questions === 'string'
        ? JSON.parse(userResult.rows[0].assigned_questions)
        : userResult.rows[0].assigned_questions;
      if (assignedObj[subject] && Array.isArray(assignedObj[subject])) {
        questionIds = assignedObj[subject];
      }
    }
    
    if (questionIds.length === 0) {
      questionIds = Object.keys(studentAnswers).map(id => parseInt(id)).filter(id => !isNaN(id));
    }
    
    if (questionIds.length === 0) {
      return res.json({ success: true, details: [], score: response.score });
    }
    
    const questionsResult = await pool.query(
      `SELECT q.*, p.passage_text 
       FROM questions q 
       LEFT JOIN passages p ON q.passage_id = p.id 
       WHERE q.id = ANY($1)`,
      [questionIds]
    );
    
    const questionMap = {};
    questionsResult.rows.forEach(q => {
      questionMap[q.id] = q;
    });
    
    const details = questionIds.map((qid, idx) => {
      const q = questionMap[qid];
      if (!q) return null;
      
      const studentAnswer = (studentAnswers[qid] || '').toUpperCase();
      const correctAnswer = (q.correct_answer || '').toUpperCase().trim();
      let correctLetter = correctAnswer;
      if (correctAnswer.startsWith('OPTION A')) correctLetter = 'A';
      else if (correctAnswer.startsWith('OPTION B')) correctLetter = 'B';
      else if (correctAnswer.startsWith('OPTION C')) correctLetter = 'C';
      else if (correctAnswer.startsWith('OPTION D')) correctLetter = 'D';
      
      return {
        qNo: idx + 1,
        question: q.question_text,
        passage: q.passage_text || null,
        optionA: q.option_a,
        optionB: q.option_b,
        optionC: q.option_c,
        optionD: q.option_d,
        correctAnswer: correctLetter,
        studentAnswer: studentAnswer,
        isCorrect: studentAnswer && studentAnswer === correctLetter
      };
    }).filter(d => d !== null);
    
    res.json({ 
      success: true, 
      details, 
      score: response.score,
      total: details.length
    });
  } catch (error) {
    console.error('Get result details error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-analytics', requireAdmin, async (req, res) => {
  try {
    // Get total students (non-admin users)
    const studentsResult = await pool.query(
      'SELECT COUNT(*) FROM users WHERE is_admin = FALSE'
    );
    const totalStudents = parseInt(studentsResult.rows[0].count) || 0;
    
    // Get total exams taken
    const examsResult = await pool.query('SELECT COUNT(*) FROM grades');
    const totalExams = parseInt(examsResult.rows[0].count) || 0;
    
    // Get average score and pass rate
    const statsResult = await pool.query(`
      SELECT 
        AVG(CAST(percentage AS FLOAT)) as avg_percentage,
        COUNT(CASE WHEN CAST(percentage AS FLOAT) >= 40 THEN 1 END) as passed,
        COUNT(*) as total
      FROM grades
    `);
    const avgScore = parseFloat(statsResult.rows[0].avg_percentage) || 0;
    const passRate = statsResult.rows[0].total > 0 
      ? (statsResult.rows[0].passed / statsResult.rows[0].total * 100) 
      : 0;
    
    // Get subject-wise performance
    const subjectResult = await pool.query(`
      SELECT 
        subject,
        AVG(CAST(percentage AS FLOAT)) as avg_percentage,
        COUNT(*) as count
      FROM grades
      GROUP BY subject
      ORDER BY subject
    `);
    
    const subjectStats = {};
    subjectResult.rows.forEach(row => {
      subjectStats[row.subject] = {
        avgPercentage: parseFloat(row.avg_percentage) || 0,
        count: parseInt(row.count) || 0
      };
    });
    
    // Get score distribution
    const distributionResult = await pool.query(`
      SELECT 
        CASE 
          WHEN CAST(percentage AS FLOAT) <= 20 THEN '0-20'
          WHEN CAST(percentage AS FLOAT) <= 40 THEN '21-40'
          WHEN CAST(percentage AS FLOAT) <= 60 THEN '41-60'
          WHEN CAST(percentage AS FLOAT) <= 80 THEN '61-80'
          ELSE '81-100'
        END as range,
        COUNT(*) as count
      FROM grades
      GROUP BY range
      ORDER BY range
    `);
    
    const distribution = {
      '0-20': 0,
      '21-40': 0,
      '41-60': 0,
      '61-80': 0,
      '81-100': 0
    };
    distributionResult.rows.forEach(row => {
      distribution[row.range] = parseInt(row.count) || 0;
    });
    
    // Get top performers
    const topResult = await pool.query(`
      SELECT display_name, subject, score, percentage
      FROM grades
      ORDER BY CAST(percentage AS FLOAT) DESC
      LIMIT 10
    `);
    
    // Get low performers (below 40%)
    const lowResult = await pool.query(`
      SELECT display_name, subject, score, percentage
      FROM grades
      WHERE CAST(percentage AS FLOAT) < 40
      ORDER BY CAST(percentage AS FLOAT) ASC
      LIMIT 10
    `);
    
    res.json({
      success: true,
      analytics: {
        totalStudents,
        totalExams,
        avgScore: avgScore.toFixed(1),
        passRate: passRate.toFixed(1),
        subjectStats,
        distribution,
        topPerformers: topResult.rows,
        lowPerformers: lowResult.rows
      }
    });
  } catch (error) {
    console.error('Get analytics error:', error);
    res.json({ success: false, message: error.message });
  }
});

module.exports = router;
