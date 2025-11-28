let session = { token: null, isAdmin: false };
let timerInterval;
let timeLeft;
let currentIndex = 0;
let currentSubject = "";
let answers = {};
let currentTotal = 0;
let visitedQuestions = {};
let markedForReview = {};
let questionIds = [];

const API_BASE = '/api';

async function apiCall(endpoint, data = {}) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    const result = await response.json();
    return result || { error: 'Empty response from server' };
  } catch (error) {
    console.error('API Error:', error);
    return { error: error.message || 'Network error' };
  }
}

function showPanel(id) {
  ['loginPanel', 'studentPanel', 'adminPanel'].forEach(p => {
    const el = document.getElementById(p);
    if (el) el.classList.add('hidden');
  });
  document.getElementById(id).classList.remove('hidden');
}

document.getElementById('login-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;
  document.getElementById('login-error').innerText = "Checking...";

  try {
    const res = await apiCall('/auth/login', { username: u, password: p });
    
    if (res && res.success) {
      session = res;
      document.getElementById('login-error').style.display = 'none';
      document.getElementById('login-error').innerText = "";
      if (res.isAdmin) {
        showPanel('adminPanel');
      } else {
        showPanel('studentPanel');
        document.getElementById('stuInfo').innerText = res.username || '';
      }
    } else {
      document.getElementById('login-error').style.display = 'block';
      document.getElementById('login-error').innerText = res && res.message ? res.message : "Login failed.";
    }
  } catch (e) {
    document.getElementById('login-error').style.display = 'block';
    document.getElementById('login-error').innerText = 'Server error: ' + (e.message || e);
  }
});

document.getElementById('studentLogoutBtn').onclick = function() {
  apiCall('/auth/logout', { token: session.token });
  session = { token: null, isAdmin: false };
  answers = {};
  showPanel('loginPanel');
};

document.getElementById('adminLogoutBtn').onclick = function() {
  apiCall('/auth/logout', { token: session.token });
  session = { token: null, isAdmin: false };
  answers = {};
  showPanel('loginPanel');
};

document.getElementById('backToLoginBtn').onclick = function() {
  session = { token: null, isAdmin: false };
  answers = {};
  showPanel('loginPanel');
};

document.getElementById('uploadUsersBtn').onclick = async function() {
  const csvText = document.getElementById('userCSV').value;
  const passwordPrefix = document.getElementById('pwPrefix').value;
  
  try {
    const res = await apiCall('/admin/bulk-create-users', {
      token: session.token,
      csvText,
      passwordPrefix
    });
    
    if (res.success) {
      alert('Users uploaded successfully!');
      document.getElementById('userCSV').value = '';
    } else {
      alert('Error: ' + (res.message || 'Failed to upload users'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('listUsersBtn').onclick = async function() {
  try {
    const res = await apiCall('/admin/get-users', { token: session.token });
    
    if (res.success && res.users) {
      let html = '<table><tr><th>Username</th><th>Display Name</th><th>Type</th><th>Action</th></tr>';
      res.users.forEach(user => {
        const type = user.is_admin ? '<span style="color:#1b5e20;font-weight:bold;">Admin</span>' : 'Student';
        const deleteBtn = user.is_admin ? '-' : `<button class="delete-user-btn" data-id="${user.id}" data-name="${user.username}">Delete</button>`;
        html += `<tr><td>${user.username}</td><td>${user.display_name || '-'}</td><td>${type}</td><td>${deleteBtn}</td></tr>`;
      });
      html += '</table>';
      document.getElementById('userListArea').innerHTML = html;
      
      document.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.onclick = async function() {
          const userId = this.dataset.id;
          const username = this.dataset.name;
          if (confirm('Delete user "' + username + '"? This will also delete their exam responses.')) {
            const delRes = await apiCall('/admin/delete-user', { token: session.token, userId });
            if (delRes.success) {
              alert('User deleted: ' + delRes.deleted);
              document.getElementById('listUsersBtn').click();
            } else {
              alert('Error: ' + (delRes.message || 'Failed to delete'));
            }
          }
        };
      });
    } else {
      alert('Error: ' + (res.message || 'Failed to get users'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('deleteAllStudentsBtn').onclick = async function() {
  if (!confirm('Are you sure you want to DELETE ALL STUDENTS?\n\nThis will remove all non-admin users and their exam responses.\n\nThis cannot be undone!')) {
    return;
  }
  
  if (!confirm('FINAL WARNING: This will delete ALL student accounts and their data. Continue?')) {
    return;
  }
  
  try {
    const res = await apiCall('/admin/delete-all-students', { token: session.token });
    
    if (res.success) {
      alert('Deleted ' + res.deleted + ' student(s) successfully!');
      document.getElementById('userListArea').innerHTML = '';
    } else {
      alert('Error: ' + (res.message || 'Failed to delete students'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('importGoogleSheetBtn').onclick = async function() {
  const sheetUrl = document.getElementById('googleSheetUrl').value.trim();
  
  if (!sheetUrl) {
    alert('Please paste your Google Sheet link first');
    return;
  }
  
  this.disabled = true;
  this.innerText = 'Importing...';
  
  try {
    const res = await apiCall('/admin/import-google-sheet', {
      token: session.token,
      sheetUrl
    });
    
    if (res.success) {
      alert('Success! Imported ' + res.added + ' questions' + (res.skipped > 0 ? ' (' + res.skipped + ' skipped)' : ''));
      document.getElementById('googleSheetUrl').value = '';
    } else {
      alert('Error: ' + (res.message || 'Failed to import from Google Sheet'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    this.disabled = false;
    this.innerText = 'Import from Sheet';
  }
};

document.getElementById('uploadWordBtn').onclick = async function() {
  const fileInput = document.getElementById('wordFileInput');
  const subject = document.getElementById('wordSubject').value;
  
  if (!fileInput.files || !fileInput.files[0]) {
    alert('Please select a Word file (.docx)');
    return;
  }
  
  const file = fileInput.files[0];
  if (!file.name.endsWith('.docx')) {
    alert('Please select a .docx file');
    return;
  }
  
  this.disabled = true;
  this.innerText = 'Uploading...';
  
  try {
    const reader = new FileReader();
    reader.onload = async function(e) {
      const base64 = e.target.result.split(',')[1];
      
      try {
        const res = await apiCall('/admin/upload-word-questions', {
          token: session.token,
          wordBase64: base64,
          subject: subject,
          filename: file.name
        });
        
        if (res.success) {
          alert('Success! Added ' + res.added + ' questions' + (res.passages > 0 ? ' with ' + res.passages + ' passages' : ''));
          fileInput.value = '';
        } else {
          alert('Error: ' + (res.message || 'Failed to upload Word file'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
      
      document.getElementById('uploadWordBtn').disabled = false;
      document.getElementById('uploadWordBtn').innerText = 'Upload Word File';
    };
    reader.readAsDataURL(file);
  } catch (e) {
    alert('Error reading file: ' + e.message);
    this.disabled = false;
    this.innerText = 'Upload Word File';
  }
};

document.getElementById('viewQuestionsBtn').onclick = async function() {
  try {
    const res = await apiCall('/admin/get-question-count', { token: session.token });
    
    if (res.success) {
      let html = '<div style="margin-top:10px;padding:15px;background:#e8f5e9;border-radius:8px;">';
      html += '<strong>Question Bank Summary:</strong><br><br>';
      
      if (res.counts && res.counts.length > 0) {
        res.counts.forEach(row => {
          html += `<div style="margin:5px 0;">📚 <b>${row.subject}:</b> ${row.count} questions</div>`;
        });
        html += `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #a5d6a7;">📖 Total Passages: ${res.passageCount}</div>`;
      } else {
        html += '<div style="color:#c62828;">No questions uploaded yet.</div>';
      }
      html += '</div>';
      document.getElementById('questionCountArea').innerHTML = html;
    } else {
      alert('Error: ' + (res.message || 'Failed to get count'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('clearQuestionsBtn').onclick = async function() {
  if (!confirm('Are you sure you want to DELETE ALL QUESTIONS from all subjects?\n\nThis cannot be undone!')) {
    return;
  }
  
  try {
    const res = await apiCall('/admin/clear-questions', {
      token: session.token,
      subject: 'all'
    });
    
    if (res.success) {
      alert(res.message);
      document.getElementById('questionCountArea').innerHTML = '';
      document.getElementById('viewQuestionsBtn').click();
      refreshUploadsList();
    } else {
      alert('Error: ' + (res.message || 'Failed to clear'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

async function refreshUploadsList() {
  try {
    const res = await apiCall('/admin/get-uploads', { token: session.token });
    const select = document.getElementById('uploadSelect');
    select.innerHTML = '<option value="">-- Select uploaded file --</option>';
    
    if (res.success && res.uploads && res.uploads.length > 0) {
      res.uploads.forEach(upload => {
        const date = new Date(upload.uploaded_at).toLocaleDateString();
        const opt = document.createElement('option');
        opt.value = upload.id;
        opt.textContent = `${upload.filename} (${upload.subject}) - ${upload.question_count} Qs - ${date}`;
        select.appendChild(opt);
      });
    }
  } catch (e) {
    console.error('Error refreshing uploads:', e);
  }
}

document.getElementById('refreshUploadsBtn').onclick = refreshUploadsList;

document.getElementById('deleteUploadBtn').onclick = async function() {
  const select = document.getElementById('uploadSelect');
  const uploadId = select.value;
  
  if (!uploadId) {
    alert('Please select an uploaded file first');
    return;
  }
  
  const selectedText = select.options[select.selectedIndex].text;
  if (!confirm(`Delete "${selectedText}"?\n\nThis will remove all questions from this upload.`)) {
    return;
  }
  
  try {
    const res = await apiCall('/admin/delete-upload', {
      token: session.token,
      uploadId: parseInt(uploadId)
    });
    
    if (res.success) {
      alert(res.message);
      refreshUploadsList();
      document.getElementById('viewQuestionsBtn').click();
    } else {
      alert('Error: ' + (res.message || 'Failed to delete'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('saveTotalQBtn').onclick = async function() {
  const total = document.getElementById('totalQ').value;
  
  try {
    const res = await apiCall('/admin/set-total-questions', {
      token: session.token,
      total
    });
    
    if (res.success) {
      alert('Total questions saved!');
    } else {
      alert('Error: ' + (res.message || 'Failed to save'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('enableExam').onclick = async function() {
  try {
    const res = await apiCall('/admin/set-exam-active', {
      token: session.token,
      active: true
    });
    
    if (res.success) {
      alert('Exam enabled!');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('disableExam').onclick = async function() {
  try {
    const res = await apiCall('/admin/set-exam-active', {
      token: session.token,
      active: false
    });
    
    if (res.success) {
      alert('Exam disabled!');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('setActiveSubBtn').onclick = async function() {
  const subject = document.getElementById('activeSubject').value;
  
  try {
    const res = await apiCall('/admin/set-active-subject', {
      token: session.token,
      subject
    });
    
    if (res.success) {
      alert('Active subject set to: ' + res.activeSubject);
    } else {
      alert('Error: ' + (res.message || 'Failed to set subject'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('refreshActiveSubBtn').onclick = async function() {
  try {
    const res = await apiCall('/exam/get-active-subject', {
      token: session.token
    });
    
    if (res.subject) {
      document.getElementById('activeSubject').value = res.subject;
      alert('Current active subject: ' + res.subject);
    } else {
      alert('Error: ' + (res.error || 'Failed to get subject'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('viewReportBtn').onclick = async function() {
  try {
    const res = await apiCall('/admin/get-summary', {
      token: session.token
    });
    
    if (res.success) {
      let html = `<table><tr><th>Timestamp</th><th>User</th><th>Subject</th><th>Score</th><th>Details</th></tr>`;
      (res.data || []).forEach(function(row) {
        const viewBtn = `<button class="view-details-btn" data-user="${row.username}" data-subject="${row.subject}">View</button>`;
        html += `<tr><td>${row.timestamp ? new Date(row.timestamp).toLocaleString() : ""}</td><td>${row.username || ""}</td><td>${row.subject || ""}</td><td>${row.score || ""}</td><td>${viewBtn}</td></tr>`;
      });
      document.getElementById('summaryArea').innerHTML = html + "</table>";
      
      document.querySelectorAll('.view-details-btn').forEach(btn => {
        btn.onclick = function() {
          viewResultDetails(this.dataset.user, this.dataset.subject);
        };
      });
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

async function viewResultDetails(username, subject) {
  try {
    const res = await apiCall('/admin/get-result-details', {
      token: session.token,
      username,
      subject
    });
    
    if (res.success) {
      document.getElementById('detailModalTitle').innerText = `${username} - ${subject} (Score: ${res.score}/${res.total})`;
      
      let html = '';
      (res.details || []).forEach(function(q) {
        const statusIcon = q.isCorrect ? '✓' : '✗';
        const statusClass = q.isCorrect ? 'correct' : 'wrong';
        
        html += `<div class="detail-question">`;
        if (q.passage) {
          html += `<div style="background:#e3f2fd;padding:10px;border-radius:8px;margin-bottom:10px;font-style:italic;font-size:13px;">${q.passage}</div>`;
        }
        html += `<div class="detail-question-text">Q${q.qNo}. ${q.question}</div>`;
        html += `<div class="detail-options">`;
        html += `<div class="detail-option ${q.correctAnswer === 'A' ? 'correct' : (q.studentAnswer === 'A' && !q.isCorrect ? 'wrong' : '')}">A) ${q.optionA || '-'}</div>`;
        html += `<div class="detail-option ${q.correctAnswer === 'B' ? 'correct' : (q.studentAnswer === 'B' && !q.isCorrect ? 'wrong' : '')}">B) ${q.optionB || '-'}</div>`;
        html += `<div class="detail-option ${q.correctAnswer === 'C' ? 'correct' : (q.studentAnswer === 'C' && !q.isCorrect ? 'wrong' : '')}">C) ${q.optionC || '-'}</div>`;
        html += `<div class="detail-option ${q.correctAnswer === 'D' ? 'correct' : (q.studentAnswer === 'D' && !q.isCorrect ? 'wrong' : '')}">D) ${q.optionD || '-'}</div>`;
        html += `</div>`;
        html += `<div class="detail-answer">Answer: ${q.correctAnswer} ${q.studentAnswer ? `| Student: ${q.studentAnswer} ${statusIcon}` : '| Not answered'}</div>`;
        html += `</div>`;
      });
      
      document.getElementById('detailModalBody').innerHTML = html;
      document.getElementById('detailModal').style.display = 'flex';
    } else {
      alert('Error: ' + (res.message || 'Failed to get details'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function closeDetailModal() {
  document.getElementById('detailModal').style.display = 'none';
}

document.getElementById('exportCSVBtn').onclick = async function() {
  try {
    const res = await apiCall('/admin/export-csv', {
      token: session.token
    });
    
    if (res.success) {
      const blob = new Blob([res.csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'responses.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

document.getElementById('startExamBtn').onclick = startExamForSubject;
document.getElementById('prevBtn').onclick = prevQ;
document.getElementById('nextBtn').onclick = nextQ;
document.getElementById('submitBtn').onclick = handleEndExam;
document.getElementById('markReviewBtn').onclick = toggleMarkReview;

async function startExamForSubject() {
  let cls = document.getElementById('classSelect').value;
  if (!cls) return alert("Please select class");

  answers = {};
  currentTotal = 0;
  visitedQuestions = {};
  markedForReview = {};
  questionIds = [];
  document.getElementById('thankYou').classList.add('hidden');

  try {
    const res = await apiCall('/exam/get-active-subject', {
      token: session.token
    });
    
    if (!res || res.error) {
      alert(res?.error || "Could not get active subject from server.");
      return;
    }
    
    if (!res.subject) {
      alert("Active subject is not set by admin. Please ask admin to set the subject first.");
      return;
    }
    
    currentSubject = res.subject;
    timeLeft = 75 * 60;

    document.getElementById('preExamSection').classList.add('hidden');
    document.getElementById('studentLogoutBtn').classList.add('hidden');

    document.getElementById('examCard').classList.remove('hidden');
    document.getElementById('classInfoBanner').style.display = "inline-block";
    document.getElementById('classInfoBanner').innerHTML =
      `Class V — ${currentSubject} | Time: 75 mins`;

    startTimer();
    
    const q = await apiCall('/questions/get-question', {
      token: session.token,
      subject: currentSubject,
      index: 0
    });
    
    if (!q || q.error) {
      alert(q.error || "No questions found for " + currentSubject);
      return;
    }
    
    currentTotal = q.total || 0;
    initNavigator(currentTotal);
    renderQuestion(q, 0);
  } catch (e) {
    alert("Could not get active subject: " + (e.message || e));
  }
}

function initNavigator(total) {
  const container = document.getElementById('navDots');
  container.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('div');
    dot.className = 'nav-dot not-visited';
    dot.innerText = i + 1;
    dot.onclick = () => goToQuestion(i);
    container.appendChild(dot);
  }
}

function updateNavigator() {
  const dots = document.querySelectorAll('.nav-dot');
  dots.forEach((dot, i) => {
    dot.className = 'nav-dot';
    
    const qid = questionIds[i];
    
    if (i === currentIndex) {
      dot.classList.add('current');
    } else if (markedForReview[qid]) {
      dot.classList.add('marked');
    } else if (answers[qid]) {
      dot.classList.add('answered');
    } else if (visitedQuestions[i]) {
      dot.classList.add('skipped');
    } else {
      dot.classList.add('not-visited');
    }
  });
}

async function goToQuestion(index) {
  if (index < 0 || index >= currentTotal) return;
  
  try {
    const q = await apiCall('/questions/get-question', {
      token: session.token,
      subject: currentSubject,
      index: index
    });
    if (q && !q.error) renderQuestion(q, index);
  } catch (e) {
    console.error(e);
  }
}

function toggleMarkReview() {
  const qid = questionIds[currentIndex];
  if (!qid) return;
  
  markedForReview[qid] = !markedForReview[qid];
  updateMarkReviewButton();
  updateNavigator();
}

function updateMarkReviewButton() {
  const qid = questionIds[currentIndex];
  const btn = document.getElementById('markReviewBtn');
  if (markedForReview[qid]) {
    btn.classList.add('marked');
    btn.innerText = '✓ Marked for Review';
  } else {
    btn.classList.remove('marked');
    btn.innerText = '⚑ Mark for Review';
  }
}

function startTimer() {
  clearInterval(timerInterval);
  updateTimerUI();
  timerInterval = setInterval(function() {
    if (--timeLeft < 0) {
      clearInterval(timerInterval);
      handleEndExam();
      return;
    }
    updateTimerUI();
  }, 1000);
}

function updateTimerUI() {
  let m = Math.floor(timeLeft / 60), s = timeLeft % 60;
  document.getElementById('timerDisplay').innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
  
  const timerBox = document.getElementById('timerBox');
  if (timeLeft <= 300) {
    timerBox.classList.add('warning');
  } else {
    timerBox.classList.remove('warning');
  }
}

function updateStatsDisplay() {
  const attended = Object.keys(answers || {}).length;
  const total = currentTotal || 0;
  const remaining = total > attended ? (total - attended) : 0;
  document.getElementById('attendedNow').innerText = attended;
  document.getElementById('totalNow').innerText = total;
  document.getElementById('remainingNow').innerText = remaining;
}

function renderQuestion(q, i) {
  currentIndex = i;
  currentTotal = q.total || currentTotal || 0;
  
  if (!questionIds[i]) {
    questionIds[i] = q.id;
  }
  
  visitedQuestions[i] = true;
  
  document.getElementById('qHeader').innerText = `Question ${i + 1} of ${q.total}`;
  
  let html = '';
  
  if (q.passageText) {
    html += `<div class="passage-box">
      <div class="passage-title">Read the following passage:</div>
      <div class="passage-content">${q.passageText}</div>
    </div>`;
  }
  
  html += `<div class="question-main">${q.question || ''}</div>`;
  
  if (q.imageUrl) {
    html += `<div class="question-image-container">
      <img src="${q.imageUrl}" class="question-image" alt="Question Image" onclick="enlargeImage(this.src)">
    </div>`;
  }
  
  const optionLabels = ['A', 'B', 'C', 'D'];
  const optionImages = q.optionImages || [];
  
  optionLabels.forEach(function(opt, j) {
    if (q.options && q.options[j]) {
      let optContent = q.options[j];
      
      if (optionImages[j]) {
        html += `<label class="option-label option-with-image">
          <input type="radio" name="opt${q.id}" value="${opt}" ${answers[q.id] === opt ? "checked" : ""}>
          <span class="option-text">${opt}.</span>
          <img src="${optionImages[j]}" class="option-image" alt="Option ${opt}" onclick="event.preventDefault(); enlargeImage(this.src)">
        </label>`;
      } else {
        html += `<label class="option-label">
          <input type="radio" name="opt${q.id}" value="${opt}" ${answers[q.id] === opt ? "checked" : ""}>
          <span class="option-content">${opt}. ${optContent}</span>
        </label>`;
      }
    }
  });
  
  document.getElementById('questionArea').innerHTML = html;
  
  document.querySelectorAll('input[type=radio][name="opt' + q.id + '"]').forEach(function(el) {
    el.onchange = function() {
      answers[q.id] = this.value;
      updateStatsDisplay();
      updateNavigator();
    }
  });
  
  document.getElementById('prevBtn').disabled = (i === 0);
  document.getElementById('nextBtn').disabled = (i === (q.total - 1));
  updateStatsDisplay();
  updateNavigator();
  updateMarkReviewButton();
}

async function prevQ() {
  if (currentIndex > 0) {
    try {
      const q = await apiCall('/questions/get-question', {
        token: session.token,
        subject: currentSubject,
        index: currentIndex - 1
      });
      renderQuestion(q, currentIndex - 1);
    } catch (e) {
      console.error(e);
    }
  }
}

async function nextQ() {
  try {
    const q = await apiCall('/questions/get-question', {
      token: session.token,
      subject: currentSubject,
      index: currentIndex + 1
    });
    if (q && !q.error) renderQuestion(q, currentIndex + 1);
  } catch (e) {
    console.error(e);
  }
}

async function handleEndExam() {
  const attended = Object.keys(answers || {}).length;
  const total = currentTotal || 0;
  const pending = total - attended;
  
  const reviewCount = Object.keys(markedForReview).filter(k => markedForReview[k]).length;
  
  if (pending > 0 || reviewCount > 0) {
    let warningMsg = 'Please note:\n';
    if (pending > 0) {
      warningMsg += `- You have ${pending} unanswered question(s)\n`;
    }
    if (reviewCount > 0) {
      warningMsg += `- You have ${reviewCount} question(s) marked for review\n`;
    }
    
    if (pending > 0) {
      warningMsg += '\nYou must answer ALL questions before submitting.\nPlease go back and complete the remaining questions.';
      alert(warningMsg);
      return;
    }
    
    warningMsg += '\nDo you still want to submit?';
    if (!confirm(warningMsg)) {
      return;
    }
  }
  
  document.getElementById('submitBtn').disabled = true;
  clearInterval(timerInterval);

  try {
    const resp = await apiCall('/exam/submit', {
      token: session.token,
      subject: currentSubject,
      answers: answers
    });
    
    if (!resp || resp.success !== true) {
      alert(resp && resp.message ? resp.message : 'Submit failed');
      document.getElementById('submitBtn').disabled = false;
      return;
    }
    
    document.getElementById('examCard').classList.add('hidden');
    document.getElementById('thankYou').classList.remove('hidden');
    document.getElementById('classInfoBanner').style.display = "none";
    document.getElementById('timerDisplay').innerText = "";
    updateStatsDisplay();
  } catch (e) {
    document.getElementById('submitBtn').disabled = false;
    alert('Could not submit: ' + (e.message || e));
  }
}

function enlargeImage(src) {
  document.getElementById('modalImage').src = src;
  document.getElementById('imageModal').style.display = 'flex';
}

function closeImage() {
  document.getElementById('imageModal').style.display = 'none';
}
