(function(){
  let CATEGORIES = []; // loaded from /api/categories at boot; can grow at runtime
  const catLabel = id => (CATEGORIES.find(c=>c.id===id)||{}).label || id;

  let STATE = {
    booted:false,
    bootError:false,
    user:null, // {id, username, isAdmin} | null
    view:{name:'home'},
    category:null,
    search:'',
    authModal:null,
    authError:'',
    index:[],
    article:null,
    articleLoadError:false,
    comments:[],
    commentDraft:'',
    replyingTo:null,
    replyDraft:'',
    editDraft:null,
    editorTab:'write',
    showRevisions:false,
    banner:null,
    adminUsers:null,
    adminLoadError:false,
    pendingList:null,
    pendingLoadError:false,
    pendingCount:0,
    submittedMessage:'',
    searchResults:null,
    searchLoading:false,
    tagFilter:null,
    bookmarkedSlugs:new Set(),
    profileData:null,
    profileLoadError:false,
    leaderboard:null,
    bookmarksList:null,
    reportsList:null,
    reportsLoadError:false,
    reportCount:0,
    uploadingImage:false,
    backupSettings:null,
    backupLoadError:false,
    backupSaving:false,
    backupRunning:false,
    backupBanner:null,
    backupDraft:null,
    turnstileSiteKey:null,
    turnstileToken:null,
    totpChallenge:null,
    accountBanner:null,
    twoFaSetup:null,
    twoFaCodeInput:'',
    emailInput:'',
    showCreateUserForm:false,
    newUserDraft:{username:'',password:'',email:'',isAdmin:false},
    createUserBanner:null,
    diffOpenId:null,
    diffLines:null,
    diffLoading:false,
    notifications:[],
    unreadCount:0,
    notifDropdownOpen:false,
  };

  const root = document.getElementById('app');
  const isMe = username => !!(STATE.user && STATE.user.username === username);
  const isAdmin = () => !!(STATE.user && STATE.user.isAdmin);

  // ---------- API helper ----------
  async function api(method, path, body){
    const res = await fetch('/api'+path, {
      method,
      headers: body ? {'Content-Type':'application/json'} : undefined,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try{ data = await res.json(); }catch(e){ /* no body */ }
    if(!res.ok){
      const err = new Error((data && data.error) || ('Request failed ('+res.status+')'));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  function withTimeout(promise, ms){
    return Promise.race([
      promise,
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('Request timed out')), ms)),
    ]);
  }

  function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(s){ return (s===undefined||s===null) ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ---------- markdown-lite renderer ----------
  let codeBlockCounter = 0;
  function mdToHtml(src){
    if(!src) return '';
    const lines = esc(src).replace(/\r\n/g,'\n').split('\n');
    let html = '';
    let i = 0;
    let inCode = false, codeBuf = [];
    let listBuf = [], listType = null;
    function flushList(){
      if(listBuf.length){
        html += `<${listType}>` + listBuf.map(li=>`<li>${inline(li)}</li>`).join('') + `</${listType}>`;
        listBuf = []; listType = null;
      }
    }
    function inline(t){
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" style="max-width:100%;border-radius:6px;margin:6px 0;display:block;">');
      t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return t;
    }
    function emitCodeBlock(){
      codeBlockCounter++;
      html += `<div class="hs-codeblock"><button class="hs-copy-btn" onmousedown="event.preventDefault()" onclick="HS.copyCode(this)">Copy</button><pre><code>${codeBuf.join('\n')}</code></pre></div>`;
    }
    let paraBuf = [];
    function flushPara(){
      if(paraBuf.length){ html += `<p>${inline(paraBuf.join(' '))}</p>`; paraBuf = []; }
    }
    while(i < lines.length){
      const line = lines[i];
      if(line.trim().startsWith('```')){
        flushPara(); flushList();
        if(!inCode){ inCode = true; codeBuf = []; }
        else{ emitCodeBlock(); inCode = false; }
        i++; continue;
      }
      if(inCode){ codeBuf.push(line); i++; continue; }
      if(/^###\s+/.test(line)){ flushPara(); flushList(); html += `<h3>${inline(line.replace(/^###\s+/,''))}</h3>`; i++; continue; }
      if(/^##\s+/.test(line)){ flushPara(); flushList(); const h2text = line.replace(/^##\s+/,''); html += `<h2 id="${slugify(h2text)}">${inline(h2text)}</h2>`; i++; continue; }
      if(/^#\s+/.test(line)){ flushPara(); flushList(); html += `<h1>${inline(line.replace(/^#\s+/,''))}</h1>`; i++; continue; }
      if(/^>\s?/.test(line)){ flushPara(); flushList(); html += `<blockquote>${inline(line.replace(/^>\s?/,''))}</blockquote>`; i++; continue; }
      if(/^-\s+/.test(line)){ flushPara(); if(listType!=='ul'){flushList(); listType='ul';} listBuf.push(line.replace(/^-\s+/,'')); i++; continue; }
      if(/^\d+\.\s+/.test(line)){ flushPara(); if(listType!=='ol'){flushList(); listType='ol';} listBuf.push(line.replace(/^\d+\.\s+/,'')); i++; continue; }
      if(line.trim()===''){ flushPara(); flushList(); i++; continue; }
      paraBuf.push(line.trim());
      i++;
    }
    flushPara(); flushList();
    if(inCode && codeBuf.length) emitCodeBlock();
    return html;
  }

  function timeAgo(ts){
    const s = Math.floor((Date.now()-ts)/1000);
    if(s<60) return 'just now';
    if(s<3600) return Math.floor(s/60)+'m ago';
    if(s<86400) return Math.floor(s/3600)+'h ago';
    if(s<2592000) return Math.floor(s/86400)+'d ago';
    return new Date(ts).toLocaleDateString();
  }
  function slugify(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }

  // ---------- data ops ----------
  async function loadIndex(){
    const data = await withTimeout(api('GET','/articles'), 10000);
    STATE.index = data.articles;
  }
  async function loadCategories(){
    const data = await withTimeout(api('GET','/categories'), 10000);
    CATEGORIES = data.categories.map(c => ({id:c.slug, label:c.label}));
  }
  async function openArticle(slug){
    STATE.view = {name:'article', slug};
    STATE.article = null; STATE.comments = []; STATE.showRevisions = false; STATE.articleLoadError = false;
    STATE.diffOpenId = null; STATE.diffLines = null;
    render();
    try{
      const [articleData, commentsData] = await Promise.all([
        withTimeout(api('GET','/articles/'+encodeURIComponent(slug)), 10000),
        withTimeout(api('GET','/articles/'+encodeURIComponent(slug)+'/comments'), 10000),
      ]);
      STATE.article = articleData.article;
      STATE.comments = commentsData.comments;
      render();
    }catch(e){
      console.error('openArticle failed', e);
      STATE.articleLoadError = true;
      render();
    }
  }
  function goHome(){ STATE.view={name:'home'}; STATE.category=null; STATE.tagFilter=null; STATE.search=''; STATE.searchResults=null; render(); }
  async function goAdmin(){
    STATE.view = {name:'admin'};
    STATE.adminUsers = null; STATE.adminLoadError = false;
    render();
    try{
      const data = await withTimeout(api('GET','/admin/users'), 10000);
      STATE.adminUsers = data.users;
      render();
    }catch(e){
      console.error('goAdmin failed', e);
      STATE.adminLoadError = true;
      render();
    }
  }
  function toggleCreateUserForm(){
    STATE.showCreateUserForm = !STATE.showCreateUserForm;
    STATE.newUserDraft = {username:'',password:'',email:'',isAdmin:false};
    STATE.createUserBanner = null;
    render();
  }
  async function submitCreateUser(){
    const d = STATE.newUserDraft;
    if(!d.username.trim() || !d.password){ STATE.createUserBanner={type:'error', text:'Username and password are required.'}; render(); return; }
    try{
      await api('POST','/admin/users', {username:d.username.trim(), password:d.password, email:d.email.trim()||undefined, isAdmin:d.isAdmin});
      STATE.createUserBanner = {type:'ok', text:`${d.username.trim()} created.`};
      STATE.newUserDraft = {username:'',password:'',email:'',isAdmin:false};
      const data = await api('GET','/admin/users');
      STATE.adminUsers = data.users;
    }catch(e){
      STATE.createUserBanner = {type:'error', text:e.message};
    }
    render();
  }
  function goAccount(){
    STATE.view = {name:'account'};
    STATE.accountBanner = null;
    STATE.emailInput = '';
    STATE.twoFaSetup = null;
    STATE.twoFaCodeInput = '';
    render();
  }
  async function submitSetEmail(){
    const email = STATE.emailInput.trim();
    if(!email){ STATE.accountBanner={type:'error', text:'Enter an email address.'}; render(); return; }
    try{
      await api('POST','/auth/set-email', {email});
      const me = await api('GET','/auth/me');
      STATE.user = me.user;
      STATE.emailInput = '';
      STATE.accountBanner = {type:'ok', text:'Check your inbox for a verification code.'};
    }catch(e){
      STATE.accountBanner = {type:'error', text:e.message};
    }
    render();
  }
  async function submitVerifyEmailCode(){
    const code = document.getElementById('hs-verify-code').value;
    if(!code){ STATE.accountBanner={type:'error', text:'Enter the code from your email.'}; render(); return; }
    try{
      await api('POST','/auth/verify-email', {code});
      const me = await api('GET','/auth/me');
      STATE.user = me.user;
      STATE.accountBanner = {type:'ok', text:'Email verified.'};
    }catch(e){
      STATE.accountBanner = {type:'error', text:e.message};
    }
    render();
  }
  async function resendVerificationCode(){
    try{
      await api('POST','/auth/resend-verification');
      STATE.accountBanner = {type:'ok', text:'New code sent.'};
    }catch(e){
      STATE.accountBanner = {type:'error', text:e.message};
    }
    render();
  }
  async function startTotpSetup(){
    try{
      const data = await api('POST','/auth/2fa/setup');
      STATE.twoFaSetup = data;
      STATE.accountBanner = null;
    }catch(e){
      STATE.accountBanner = {type:'error', text:e.message};
    }
    render();
  }
  async function confirmTotpSetup(){
    const code = STATE.twoFaCodeInput.trim();
    if(!code){ STATE.accountBanner={type:'error', text:'Enter the 6-digit code from your app.'}; render(); return; }
    try{
      await api('POST','/auth/2fa/confirm', {code});
      const me = await api('GET','/auth/me');
      STATE.user = me.user;
      STATE.twoFaSetup = null;
      STATE.twoFaCodeInput = '';
      STATE.accountBanner = {type:'ok', text:'Two-factor authentication is now on.'};
    }catch(e){
      STATE.accountBanner = {type:'error', text:e.message};
    }
    render();
  }
  async function disableTotp(){
    const code = prompt('Enter your current 6-digit code to confirm disabling 2FA:');
    if(!code) return;
    try{
      await api('POST','/auth/2fa/disable', {code});
      const me = await api('GET','/auth/me');
      STATE.user = me.user;
      STATE.accountBanner = {type:'ok', text:'Two-factor authentication turned off.'};
    }catch(e){
      STATE.accountBanner = {type:'error', text:e.message};
    }
    render();
  }
  async function goBackupSettings(){
    STATE.view = {name:'backup'};
    STATE.backupSettings = null; STATE.backupLoadError = false; STATE.backupBanner = null;
    render();
    try{
      const data = await withTimeout(api('GET','/admin/backup-settings'), 10000);
      STATE.backupSettings = data.settings;
      STATE.backupDraft = {bucket:data.settings.bucket, region:data.settings.region, accessKeyId:'', secretAccessKey:'', autoEnabled:data.settings.autoEnabled};
      render();
    }catch(e){
      console.error('goBackupSettings failed', e);
      STATE.backupLoadError = true;
      render();
    }
  }
  async function saveBackupSettings(){
    STATE.backupSaving = true; STATE.backupBanner = null;
    render();
    try{
      const d = STATE.backupDraft;
      const data = await api('POST','/admin/backup-settings', {
        bucket: d.bucket, region: d.region,
        accessKeyId: d.accessKeyId || undefined,
        secretAccessKey: d.secretAccessKey || undefined,
        autoEnabled: d.autoEnabled,
      });
      STATE.backupSettings = data.settings;
      STATE.backupDraft.accessKeyId = ''; STATE.backupDraft.secretAccessKey = '';
      STATE.backupBanner = {type:'ok', text:'Saved.'};
    }catch(e){
      STATE.backupBanner = {type:'error', text:e.message};
    }
    STATE.backupSaving = false;
    render();
  }
  async function runBackupNow(){
    STATE.backupRunning = true; STATE.backupBanner = null;
    render();
    try{
      const data = await api('POST','/admin/backup-now');
      STATE.backupSettings = data.settings;
      STATE.backupBanner = {type:'ok', text:`Backup complete - ${data.result.filesUploaded} file(s) uploaded to ${data.result.prefix}`};
    }catch(e){
      STATE.backupBanner = {type:'error', text:e.message};
      if(e.data && e.data.settings) STATE.backupSettings = e.data.settings;
    }
    STATE.backupRunning = false;
    render();
  }
  async function goReview(){
    STATE.view = {name:'review'};
    STATE.pendingList = null; STATE.pendingLoadError = false;
    render();
    try{
      const data = await withTimeout(api('GET','/admin/pending'), 10000);
      STATE.pendingList = data.pending;
      STATE.pendingCount = data.pending.length;
      render();
    }catch(e){
      console.error('goReview failed', e);
      STATE.pendingLoadError = true;
      render();
    }
  }
  async function goReports(){
    STATE.view = {name:'reports'};
    STATE.reportsList = null; STATE.reportsLoadError = false;
    render();
    try{
      const data = await withTimeout(api('GET','/admin/reports'), 10000);
      STATE.reportsList = data.reports;
      STATE.reportCount = data.reports.length;
      render();
    }catch(e){
      console.error('goReports failed', e);
      STATE.reportsLoadError = true;
      render();
    }
  }
  async function loadNotifications(){
    try{
      const data = await api('GET','/notifications');
      STATE.notifications = data.notifications;
      STATE.unreadCount = data.unreadCount;
      render();
    }catch(e){ /* silent - not critical */ }
  }
  async function toggleNotifDropdown(){
    STATE.notifDropdownOpen = !STATE.notifDropdownOpen;
    if(STATE.notifDropdownOpen) await loadNotifications();
    render();
  }
  async function openNotification(n){
    STATE.notifDropdownOpen = false;
    if(!n.read){
      try{ await api('POST','/notifications/'+n.id+'/read'); }catch(e){}
      STATE.unreadCount = Math.max(0, STATE.unreadCount-1);
    }
    openArticle(n.link);
  }
  async function markAllNotifsRead(){
    try{
      await api('POST','/notifications/read-all');
      STATE.notifications = STATE.notifications.map(n=>({...n, read:true}));
      STATE.unreadCount = 0;
      render();
    }catch(e){ alert('Could not mark as read: '+e.message); }
  }
  async function refreshReportCount(){
    try{
      const data = await api('GET','/admin/reports');
      STATE.reportCount = data.reports.length;
      render();
    }catch(e){ /* silent */ }
  }
  async function dismissReport(id){
    try{
      await api('POST','/admin/reports/'+id+'/dismiss');
      STATE.reportsList = STATE.reportsList.filter(r=>r.id!==id);
      STATE.reportCount = STATE.reportsList.length;
      render();
    }catch(e){
      alert('Could not dismiss: '+e.message);
    }
  }
  async function refreshPendingCount(){
    try{
      const data = await api('GET','/admin/pending');
      STATE.pendingCount = data.pending.length;
      render();
    }catch(e){ /* silent - badge just won't update this cycle */ }
  }
  async function approvePending(id){
    if(!confirm('Publish this submission? The author will be trusted for future contributions.')) return;
    try{
      await api('POST','/admin/pending/'+id+'/approve');
      STATE.pendingList = STATE.pendingList.filter(p=>p.id!==id);
      STATE.pendingCount = STATE.pendingList.length;
      await loadIndex();
      render();
    }catch(e){
      alert('Could not approve: '+e.message);
    }
  }
  async function rejectPending(id){
    if(!confirm('Reject this submission? It will be discarded and not published.')) return;
    try{
      await api('POST','/admin/pending/'+id+'/reject');
      STATE.pendingList = STATE.pendingList.filter(p=>p.id!==id);
      STATE.pendingCount = STATE.pendingList.length;
      render();
    }catch(e){
      alert('Could not reject: '+e.message);
    }
  }
  async function toggleBan(username, currentlyBanned){
    const verb = currentlyBanned ? 'unban' : 'ban';
    const msg = currentlyBanned
      ? `Unban ${username}? They will be able to sign in again.`
      : `Ban ${username}? They will no longer be able to sign in. Their existing articles and comments stay as-is.`;
    if(!confirm(msg)) return;
    try{
      await api('POST','/admin/'+verb+'/'+encodeURIComponent(username));
      const u = STATE.adminUsers.find(x=>x.username===username);
      if(u) u.banned = !currentlyBanned;
      render();
    }catch(e){
      alert('Could not '+verb+' '+username+': '+e.message);
    }
  }
  async function toggleAdmin(username, currentlyAdmin){
    const verb = currentlyAdmin ? 'demote' : 'promote';
    const msg = currentlyAdmin
      ? `Remove admin rights from ${username}? They'll go back to a normal account.`
      : `Make ${username} an admin? They'll be able to lock articles, delete any comment, and ban/promote other users.`;
    if(!confirm(msg)) return;
    try{
      await api('POST','/admin/'+verb+'/'+encodeURIComponent(username));
      const u = STATE.adminUsers.find(x=>x.username===username);
      if(u) u.isAdmin = !currentlyAdmin;
      render();
    }catch(e){
      alert('Could not '+verb+' '+username+': '+e.message);
    }
  }
  function goNew(){
    if(!STATE.user){ STATE.authModal='login'; render(); return; }
    STATE.view={name:'new'};
    STATE.editDraft={title:'', category:CATEGORIES[0]?CATEGORIES[0].id:'', newCategoryLabel:'', body:'', tagsText:''};
    STATE.banner=null;
    STATE.editorTab='write';
    render();
  }
  function goEdit(){
    STATE.view={name:'edit', slug:STATE.article.slug};
    STATE.editDraft={title:STATE.article.title, category:STATE.article.category, newCategoryLabel:'', body:STATE.article.body, tagsText:(STATE.article.tags||[]).join(', ')};
    STATE.banner=null;
    STATE.editorTab='write';
    render();
  }

  async function submitNewArticle(){
    const d = STATE.editDraft;
    if(!d.title.trim() || !d.body.trim()){ STATE.banner={type:'error', text:'Title and body are required.'}; render(); return; }
    if(d.category==='__new__' && !d.newCategoryLabel.trim()){ STATE.banner={type:'error', text:'Enter a name for the new category.'}; render(); return; }
    try{
      const tags = d.tagsText.split(',').map(t=>t.trim()).filter(Boolean);
      const payload = {title:d.title, body:d.body, tags};
      if(d.category==='__new__'){ payload.category=null; payload.newCategoryLabel=d.newCategoryLabel.trim(); }
      else{ payload.category=d.category; }
      const res = await api('POST','/articles', payload);
      if(res.pending){
        STATE.view = {name:'submitted'};
        STATE.submittedMessage = `Your article "${d.title.trim()}" has been submitted for review. An admin will publish it once approved - after your first approval, future contributions go live right away.`;
        loadCategories();
        render();
        return;
      }
      await Promise.all([loadIndex(), loadCategories()]);
      openArticle(res.slug);
    }catch(e){
      STATE.banner={type:'error', text:e.message}; render();
    }
  }
  async function submitEdit(){
    const d = STATE.editDraft;
    if(!d.title.trim() || !d.body.trim()){ STATE.banner={type:'error', text:'Title and body are required.'}; render(); return; }
    if(d.category==='__new__' && !d.newCategoryLabel.trim()){ STATE.banner={type:'error', text:'Enter a name for the new category.'}; render(); return; }
    try{
      const tags = d.tagsText.split(',').map(t=>t.trim()).filter(Boolean);
      const payload = {title:d.title, body:d.body, tags};
      if(d.category==='__new__'){ payload.category=null; payload.newCategoryLabel=d.newCategoryLabel.trim(); }
      else{ payload.category=d.category; }
      const res = await api('PUT','/articles/'+encodeURIComponent(STATE.article.slug), payload);
      if(res.pending){
        STATE.view = {name:'submitted'};
        STATE.submittedMessage = `Your edit to "${d.title.trim()}" has been submitted for review. An admin will apply it once approved - after your first approval, future contributions go live right away.`;
        loadCategories();
        render();
        return;
      }
      await Promise.all([loadIndex(), loadCategories()]);
      openArticle(STATE.article.slug);
    }catch(e){
      STATE.banner={type:'error', text:e.message}; render();
    }
  }
  async function restoreRevision(revId){
    if(!confirm('Restore this older version? This becomes the current version (history is kept).')) return;
    try{
      const res = await api('POST','/articles/'+encodeURIComponent(STATE.article.slug)+'/restore/'+revId, {});
      if(res.pending){
        STATE.view = {name:'submitted'};
        STATE.submittedMessage = `Your restore has been submitted for review. An admin will apply it once approved - after your first approval, future contributions go live right away.`;
        render();
        return;
      }
      await loadIndex();
      STATE.showRevisions = false;
      openArticle(STATE.article.slug);
    }catch(e){
      alert('Could not restore that revision: '+e.message);
    }
  }
  async function toggleLock(){
    const next = !STATE.article.locked;
    const verb = next ? 'lock' : 'unlock';
    if(!confirm(`${next?'Lock':'Unlock'} this article? ${next ? 'Only admins will be able to edit it until it is unlocked.' : 'Any signed-in user will be able to edit it again.'}`)) return;
    try{
      await api('PUT','/articles/'+encodeURIComponent(STATE.article.slug)+'/lock', {locked: next});
      await loadIndex();
      openArticle(STATE.article.slug);
    }catch(e){
      alert('Could not '+verb+' this article: '+e.message);
    }
  }
  async function toggleBookmark(){
    if(!STATE.user){ STATE.authModal='login'; render(); return; }
    try{
      const data = await api('POST','/articles/'+encodeURIComponent(STATE.article.slug)+'/bookmark');
      STATE.article.isBookmarked = data.bookmarked;
      render();
    }catch(e){
      alert('Could not update bookmark: '+e.message);
    }
  }
  async function castVote(vote){
    if(!STATE.user){ STATE.authModal='login'; render(); return; }
    try{
      const data = await api('POST','/articles/'+encodeURIComponent(STATE.article.slug)+'/vote', {vote});
      STATE.article.helpful = data.helpful;
      STATE.article.notHelpful = data.notHelpful;
      STATE.article.myVote = data.myVote;
      render();
    }catch(e){
      alert('Could not record vote: '+e.message);
    }
  }
  function exportMarkdown(){
    const a = STATE.article;
    const blob = new Blob([a.body], {type:'text/markdown'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = a.slug+'.md';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }
  async function reportArticle(){
    const reason = prompt('What\'s wrong with this article? (goes to admins only)');
    if(!reason || !reason.trim()) return;
    try{
      await api('POST','/articles/'+encodeURIComponent(STATE.article.slug)+'/report', {reason: reason.trim()});
      alert('Thanks - an admin will take a look.');
      if(STATE.user && STATE.user.isAdmin) refreshReportCount();
    }catch(e){
      alert('Could not submit report: '+e.message);
    }
  }
  async function reportComment(id){
    const reason = prompt('What\'s wrong with this comment? (goes to admins only)');
    if(!reason || !reason.trim()) return;
    try{
      await api('POST','/comments/'+id+'/report', {reason: reason.trim()});
      alert('Thanks - an admin will take a look.');
      if(STATE.user && STATE.user.isAdmin) refreshReportCount();
    }catch(e){
      alert('Could not submit report: '+e.message);
    }
  }
  async function openProfile(username){
    STATE.view = {name:'profile', username};
    STATE.profileData = null; STATE.profileLoadError = false;
    render();
    try{
      const data = await withTimeout(api('GET','/users/'+encodeURIComponent(username)+'/profile'), 10000);
      STATE.profileData = data.profile;
      render();
    }catch(e){
      console.error('openProfile failed', e);
      STATE.profileLoadError = true;
      render();
    }
  }
  async function goLeaderboard(){
    STATE.view = {name:'leaderboard'};
    STATE.leaderboard = null;
    render();
    try{
      const data = await withTimeout(api('GET','/leaderboard'), 10000);
      STATE.leaderboard = data.leaderboard;
      render();
    }catch(e){
      STATE.leaderboard = [];
      render();
    }
  }
  async function goBookmarks(){
    if(!STATE.user){ STATE.authModal='login'; render(); return; }
    STATE.view = {name:'bookmarks'};
    STATE.leaderboard = null; // reuse loading pattern; separate field below
    STATE.bookmarksList = null;
    render();
    try{
      const data = await withTimeout(api('GET','/bookmarks'), 10000);
      STATE.bookmarksList = data.articles;
      render();
    }catch(e){
      STATE.bookmarksList = [];
      render();
    }
  }
  async function banAuthor(username){
    if(!confirm(`Ban ${username}? They will no longer be able to sign in. Their existing articles and comments stay as-is.`)) return;
    try{
      await api('POST','/admin/ban/'+encodeURIComponent(username));
      alert(username+' has been banned.');
    }catch(e){
      alert('Could not ban '+username+': '+e.message);
    }
  }
  async function submitComment(parentId){
    if(!STATE.user){ STATE.authModal='login'; render(); return; }
    const text = (parentId ? STATE.replyDraft : STATE.commentDraft).trim();
    if(!text) return;
    try{
      const c = await api('POST','/articles/'+encodeURIComponent(STATE.article.slug)+'/comments', {body:text, parentId: parentId || null});
      STATE.comments.push(c);
      if(parentId){ STATE.replyingTo = null; STATE.replyDraft = ''; }
      else{ STATE.commentDraft = ''; }
      const idx = STATE.index.find(a=>a.slug===STATE.article.slug);
      if(idx) idx.commentCount = (idx.commentCount||0)+1;
      render();
    }catch(e){
      alert('Could not post comment: '+e.message);
    }
  }
  async function deleteComment(id){
    if(!confirm('Delete this comment? It will show as "[deleted]" but stay in place so any replies underneath keep their context.')) return;
    try{
      await api('DELETE','/comments/'+id);
      const c = STATE.comments.find(x=>x.id===id);
      if(c){ c.deleted = true; c.body = null; c.author = null; }
      const idx = STATE.index.find(a=>a.slug===STATE.article.slug);
      if(idx) idx.commentCount = Math.max(0,(idx.commentCount||1)-1);
      render();
    }catch(e){
      alert('Could not delete comment: '+e.message);
    }
  }

  // ---------- auth ----------
  async function submitAuth(){
    const u = document.getElementById('hs-auth-user').value;
    const p = document.getElementById('hs-auth-pass').value;
    if(!u || !p){ STATE.authError='Enter a username and password.'; render(); return; }
    try{
      const payload = {username:u, password:p};
      if(STATE.authModal==='signup'){
        const emailEl = document.getElementById('hs-auth-email');
        if(emailEl && emailEl.value.trim()) payload.email = emailEl.value.trim();
        if(STATE.turnstileSiteKey) payload.captchaToken = STATE.turnstileToken;
      }
      const data = await api('POST','/auth/'+STATE.authModal, payload);
      if(data.requiresTotp){
        STATE.totpChallenge = {tempToken: data.tempToken};
        STATE.authError = '';
        render();
        return;
      }
      STATE.user = data.user;
      STATE.authModal = null; STATE.authError=''; STATE.totpChallenge = null; STATE.turnstileToken = null;
      render();
      if(STATE.user.isAdmin){ refreshPendingCount(); refreshReportCount(); }
      loadNotifications();
    }catch(e){
      STATE.authError = e.message; render();
    }
  }
  async function submitTotpChallenge(){
    const code = document.getElementById('hs-totp-code').value;
    if(!code){ STATE.authError='Enter the 6-digit code.'; render(); return; }
    try{
      const data = await api('POST','/auth/login/totp', {tempToken: STATE.totpChallenge.tempToken, code});
      STATE.user = data.user;
      STATE.authModal = null; STATE.authError=''; STATE.totpChallenge = null;
      render();
      if(STATE.user.isAdmin){ refreshPendingCount(); refreshReportCount(); }
      loadNotifications();
    }catch(e){
      STATE.authError = e.message; render();
    }
  }
  async function doLogout(){
    try{ await api('POST','/auth/logout'); }catch(e){}
    STATE.user = null; render();
  }

  // ---------- markdown toolbar ----------
  function getBodyTextarea(){ return document.getElementById('hs-body-textarea'); }
  function applyWrap(before, after, placeholder){
    const ta = getBodyTextarea(); if(!ta) return;
    const start = ta.selectionStart, end = ta.selectionEnd, val = ta.value;
    const sel = val.slice(start,end) || placeholder;
    const newVal = val.slice(0,start) + before + sel + after + val.slice(end);
    ta.value = newVal;
    ta.focus();
    ta.setSelectionRange(start+before.length, start+before.length+sel.length);
    STATE.editDraft.body = newVal;
  }
  function applyLinePrefix(transformLine){
    const ta = getBodyTextarea(); if(!ta) return;
    const start = ta.selectionStart, end = ta.selectionEnd, val = ta.value;
    let lineStart = val.lastIndexOf('\n', start-1)+1;
    let lineEnd = val.indexOf('\n', end);
    if(lineEnd === -1) lineEnd = val.length;
    const block = val.slice(lineStart, lineEnd);
    const newBlock = block.split('\n').map(transformLine).join('\n');
    const newVal = val.slice(0,lineStart) + newBlock + val.slice(lineEnd);
    ta.value = newVal;
    ta.focus();
    ta.setSelectionRange(lineStart, lineStart+newBlock.length);
    STATE.editDraft.body = newVal;
  }
  function tbAction(type){
    switch(type){
      case 'bold': applyWrap('**','**','bold text'); break;
      case 'italic': applyWrap('*','*','italic text'); break;
      case 'code': applyWrap('`','`','code'); break;
      case 'codeblock': applyWrap('\n```\n','\n```\n','your code here'); break;
      case 'h1': applyLinePrefix(l => '# '+l.replace(/^#{1,3}\s*/,'')); break;
      case 'h2': applyLinePrefix(l => '## '+l.replace(/^#{1,3}\s*/,'')); break;
      case 'h3': applyLinePrefix(l => '### '+l.replace(/^#{1,3}\s*/,'')); break;
      case 'ul': applyLinePrefix(l => l.trim()==='' ? l : '- '+l.replace(/^-\s*/,'')); break;
      case 'ol': applyLinePrefix((l,i) => l.trim()==='' ? l : '1. '+l.replace(/^\d+\.\s*/,'')); break;
      case 'quote': applyLinePrefix(l => '> '+l.replace(/^>\s*/,'')); break;
      case 'link': {
        const ta = getBodyTextarea(); if(!ta) return;
        const start = ta.selectionStart, end = ta.selectionEnd, val = ta.value;
        const sel = val.slice(start,end) || 'link text';
        const newVal = val.slice(0,start) + '['+sel+'](https://)' + val.slice(end);
        ta.value = newVal; ta.focus();
        const urlPos = start + 1 + sel.length + 2;
        ta.setSelectionRange(urlPos, urlPos+8);
        STATE.editDraft.body = newVal;
        break;
      }
    }
  }
  function copyCode(btn){
    const code = btn.parentElement.querySelector('code');
    if(!code) return;
    const done = ok => {
      btn.textContent = ok ? 'Copied!' : 'Failed';
      btn.classList.toggle('copied', ok);
      setTimeout(()=>{ btn.textContent='Copy'; btn.classList.remove('copied'); }, 1500);
    };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(code.textContent).then(()=>done(true)).catch(()=>done(false));
    }else{
      done(false);
    }
  }
  async function uploadImage(inputEl){
    const file = inputEl.files && inputEl.files[0];
    if(!file) return;
    if(file.size > 5*1024*1024){ alert('Images must be under 5MB.'); inputEl.value=''; return; }
    STATE.uploadingImage = true;
    render();
    try{
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch('/api/uploads', { method:'POST', credentials:'include', body: fd });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Upload failed.');
      const ta = getBodyTextarea();
      if(ta){
        const start = ta.selectionStart, end = ta.selectionEnd, val = ta.value;
        const needsLeadingBreak = start > 0 && val[start-1] !== '\n';
        const needsTrailingBreak = end < val.length && val[end] !== '\n';
        const insertion = (needsLeadingBreak?'\n':'') + `![${file.name.replace(/\.[a-z0-9]+$/i,'')}](${data.url})` + (needsTrailingBreak?'\n':'');
        const newVal = val.slice(0,start) + insertion + val.slice(end);
        ta.value = newVal;
        ta.focus();
        ta.setSelectionRange(start+insertion.length, start+insertion.length);
        STATE.editDraft.body = newVal;
      }
    }catch(e){
      alert('Could not upload image: '+e.message);
    }
    STATE.uploadingImage = false;
    inputEl.value = '';
    render();
  }

  // ---------- render helpers ----------
  function filteredIndex(){
    if(STATE.search.trim()){
      return STATE.searchResults || [];
    }
    let list = STATE.index.slice();
    if(STATE.category) list = list.filter(a=>a.category===STATE.category);
    if(STATE.tagFilter) list = list.filter(a=>(a.tags||[]).includes(STATE.tagFilter));
    return list.sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  let searchDebounceTimer = null;
  function runSearch(q){
    clearTimeout(searchDebounceTimer);
    if(!q.trim()){ STATE.searchResults = null; STATE.searchLoading = false; render(); return; }
    STATE.searchLoading = true;
    render();
    searchDebounceTimer = setTimeout(async ()=>{
      try{
        const data = await withTimeout(api('GET','/search?q='+encodeURIComponent(q.trim())), 10000);
        if(STATE.search.trim() === q.trim()){ // ignore stale responses from an earlier keystroke
          STATE.searchResults = data.results;
          STATE.searchLoading = false;
          render();
        }
      }catch(e){
        console.error('search failed', e);
        STATE.searchResults = [];
        STATE.searchLoading = false;
        render();
      }
    }, 300);
  }
  function contributorCount(){
    const set = new Set(STATE.index.map(a=>a.updatedBy).filter(Boolean));
    return set.size || 1;
  }
  function renderStatusBar(){
    return `<div class="hs-statusbar">
      <span><span class="dot"></span> online</span>
      <span class="sep">|</span>
      <span>${STATE.index.length} article${STATE.index.length===1?'':'s'}</span>
      <span class="sep">|</span>
      <span>${contributorCount()} contributor${contributorCount()===1?'':'s'}</span>
      <span class="sep">|</span>
      <span>community-maintained, edits kept in history</span>
    </div>`;
  }
  function renderNav(){
    return `<div class="hs-nav">
      <div class="hs-brand" onclick="HS.goHome()">
        <span class="p1">runbook</span><span class="p2">IT</span><span class="p3">.wiki</span>
      </div>
      <div class="hs-nav-actions">
        <input class="hs-search" type="text" placeholder="Search ${STATE.index.length} how-tos" value="${escAttr(STATE.search)}" oninput="HS.onSearch(this.value)" />
        ${STATE.user ? `<button class="ghost" onclick="HS.goBookmarks()">Bookmarks</button>` : ''}
        <button class="ghost" onclick="HS.goLeaderboard()">Leaderboard</button>
        <a href="/rss.xml" target="_blank" class="ghost" style="text-decoration:none;padding:7px 12px;border:1px solid var(--border);border-radius:4px;font-family:var(--mono);font-size:12.5px;">RSS</a>
        <button class="primary" onclick="HS.goNew()">+ New Article</button>
        ${STATE.user ? `<div style="position:relative;">
          <button class="ghost" onclick="HS.toggleNotifDropdown()">&#128276;${STATE.unreadCount>0?` <span style="background:var(--danger);color:#fff;padding:1px 6px;font-size:10px;font-weight:700;">${STATE.unreadCount}</span>`:''}</button>
          ${STATE.notifDropdownOpen ? renderNotifDropdown() : ''}
        </div>` : ''}
        ${STATE.user ? `<div class="hs-userchip">signed in as <a href="#" onclick="HS.goAccount();return false;"><b>${escAttr(STATE.user.username)}</b></a>${STATE.user.isAdmin?`<a href="#" onclick="HS.goAdmin();return false;" class="hs-admin-badge" style="text-decoration:none;cursor:pointer;">admin</a>`:''}${(STATE.user.isAdmin && STATE.pendingCount>0)?`<a href="#" onclick="HS.goReview();return false;" class="hs-admin-badge" style="text-decoration:none;cursor:pointer;background:var(--danger);">review (${STATE.pendingCount})</a>`:''}${(STATE.user.isAdmin && STATE.reportCount>0)?`<a href="#" onclick="HS.goReports();return false;" class="hs-admin-badge" style="text-decoration:none;cursor:pointer;background:var(--danger);">reports (${STATE.reportCount})</a>`:''}<button class="ghost" onclick="HS.logout()">Sign out</button></div>`
          : `<button onclick="HS.openAuth('login')">Sign in</button><button onclick="HS.openAuth('signup')">Sign up</button>`}
      </div>
    </div>`;
  }
  function renderSidebar(){
    const counts = {};
    STATE.index.forEach(a=>{ counts[a.category]=(counts[a.category]||0)+1; });
    return `<div class="hs-sidebar">
      <h4>Categories</h4>
      <div class="hs-cat-item ${STATE.category===null?'active':''}" onclick="HS.setCategory(null)">
        <span>All articles</span><span class="count">${STATE.index.length}</span>
      </div>
      ${CATEGORIES.map(c=>`<div class="hs-cat-item ${STATE.category===c.id?'active':''}" onclick="HS.setCategory('${c.id}')">
        <span>${c.label}</span><span class="count">${counts[c.id]||0}</span>
      </div>`).join('')}
    </div>`;
  }
  function renderHome(){
    const list = filteredIndex();
    const heading = STATE.search ? `Search: "${escAttr(STATE.search)}"` : (STATE.tagFilter ? `Tag: ${escAttr(STATE.tagFilter)}` : (STATE.category ? catLabel(STATE.category) : 'All Articles'));
    return `<div class="hs-main">
      ${STATE.category===null && !STATE.search && !STATE.tagFilter ? `<div class="hs-hero">
        <h1>AI can troubleshoot it. <span class="accent">Runbook it</span> so it's still there next time.</h1>
        <p>Community-written IT how-tos - vetted, corrected, and kept up to date by people who've actually done the work.</p>
      </div>` : ''}
      <div class="hs-list-head"><h2>${heading}</h2>${STATE.tagFilter ? `<button class="ghost" onclick="HS.setTagFilter(null)">Clear tag</button>` : ''}</div>
      ${STATE.search.trim() && STATE.searchLoading ? `<div class="hs-empty">Searching...</div>` :
        list.length===0 ? `<div class="hs-empty">${STATE.search.trim() ? "No articles matched that search." : "Nothing here yet. Be the first to add an article in this category."}</div>` :
        list.map((a,i)=>`<div class="hs-card">
          <div onclick="HS.openArticle('${a.slug}')" style="cursor:pointer;">
            <p class="hs-card-title">${escAttr(a.title)}</p>
            <p class="hs-card-excerpt">${escAttr(a.excerpt)}</p>
          </div>
          <div class="hs-card-meta">
            <span class="hs-tag">${catLabel(a.category)}</span>
            ${a.locked ? `<span class="hs-tag locked">locked</span>` : ''}
            <span>#${String(list.length-i).padStart(4,'0')}</span>
            <span>edited ${timeAgo(a.updatedAt)} by ${escAttr(a.updatedBy||'unknown')}</span>
            <span>${a.commentCount||0} comment${(a.commentCount||0)===1?'':'s'}</span>
            <span>${a.revisionCount||1} revision${(a.revisionCount||1)===1?'':'s'}</span>
          </div>
          ${(a.tags&&a.tags.length) ? `<div class="hs-card-meta" style="margin-top:6px;">${a.tags.map(t=>`<span class="hs-tag" style="cursor:pointer;" onclick="event.stopPropagation();HS.setTagFilter('${escAttr(t)}')">#${escAttr(t)}</span>`).join('')}</div>` : ''}
        </div>`).join('')}
    </div>`;
  }
  function renderArticle(){
    const a = STATE.article;
    if(STATE.articleLoadError){
      return `<div class="hs-main"><div class="hs-empty">Couldn't load this article (network error or the server is unreachable).<br><br>
        <button class="primary" onclick="HS.openArticle('${STATE.view.slug}')">Try again</button>
        <button class="ghost" onclick="HS.goHome()">Back to all articles</button>
      </div></div>`;
    }
    if(!a) return `<div class="hs-main"><div class="hs-empty">Loading...</div></div>`;
    let editControl;
    if(a.locked && !isAdmin()){
      editControl = `<span class="hs-hint mono" style="color:var(--danger);">locked by an admin - editing disabled</span>`;
    }else if(STATE.user){
      editControl = `<button class="primary" onclick="HS.goEdit()">Edit this article</button>`;
    }else{
      editControl = `<button onclick="HS.openAuth('login')">Sign in to edit</button>`;
    }
    const articleContributors = new Set((a.revisions||[]).map(r=>r.editor.replace(/ \(restored\)$/,''))).size || 1;
    return `<div class="hs-main">
      <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / ${catLabel(a.category)}</div>
      <div class="hs-article-head">
        <h1>${escAttr(a.title)} ${a.locked ? '<span class="hs-tag locked">locked</span>' : ''}</h1>
        <div class="hs-trustbar">
          <span class="fresh">Updated ${timeAgo(a.updatedAt)}</span>
          <span class="sep">|</span><a href="#" onclick="HS.toggleRevisions();return false;">${(a.revisions||[]).length} revision${(a.revisions||[]).length===1?'':'s'}</a>
          <span class="sep">|</span><span>${articleContributors} contributor${articleContributors===1?'':'s'}</span>
          <span class="sep">|</span><span>by <a href="#" onclick="HS.openProfile('${escAttr(a.updatedBy)}');return false;">${escAttr(a.updatedBy)}</a></span>
          <span class="spacer">
            ${editControl}
            ${isAdmin() ? `<button class="ghost" onclick="HS.toggleLock()">${a.locked ? 'Unlock' : 'Lock'}</button>` : ''}
            ${STATE.user ? `<button class="ghost" onclick="HS.toggleBookmark()">${a.isBookmarked ? '\u2605 Bookmarked' : '\u2606 Bookmark'}</button>` : ''}
            <button class="ghost" onclick="HS.exportMarkdown()">Export .md</button>
            ${STATE.user ? `<button class="ghost" onclick="HS.reportArticle()">Report</button>` : ''}
          </span>
        </div>
        <div class="hs-votebar">
          ${STATE.user ? `
            <button class="ghost ${a.myVote===1?'active-vote':''}" onclick="HS.castVote(${a.myVote===1?0:1})">&#128077; Helpful (${a.helpful||0})</button>
            <button class="ghost ${a.myVote===-1?'active-vote':''}" onclick="HS.castVote(${a.myVote===-1?0:-1})">&#128078; Not helpful (${a.notHelpful||0})</button>
          ` : `<span class="hs-hint">${a.helpful||0} found this helpful, ${a.notHelpful||0} did not. <a href="#" onclick="HS.openAuth('login');return false;">Sign in</a> to vote.</span>`}
        </div>
        ${(a.tags&&a.tags.length) ? `<div class="hs-card-meta" style="margin-top:8px;">${a.tags.map(t=>`<span class="hs-tag" style="cursor:pointer;" onclick="HS.setTagFilter('${escAttr(t)}')">#${escAttr(t)}</span>`).join('')}</div>` : ''}
        <div class="hs-openline">Anyone with a free account can edit. Every change is kept and can be restored.</div>
      </div>
      ${STATE.showRevisions ? renderRevisions(a) : ''}
      <div class="hs-body">${mdToHtml(a.body)}</div>
      ${renderRelated(a)}
      ${renderComments()}
    </div>`;
  }
  function renderRelated(a){
    const rel = STATE.index.filter(x => x.category===a.category && x.slug!==a.slug).slice(0,3);
    if(!rel.length) return '';
    return `<div class="hs-related"><h4>Related how-tos</h4>
      ${rel.map(r=>`<div class="hs-related-row">
        <a href="#" onclick="HS.openArticle('${r.slug}');return false;">${escAttr(r.title)}</a>
        <span>${timeAgo(r.updatedAt)}</span>
      </div>`).join('')}
    </div>`;
  }
  function renderToc(){
    const a = STATE.article;
    if(!a || !a.body) return '';
    const heads = (a.body.replace(/\r\n/g,'\n').match(/^##\s+(.+)$/gm)||[]).map(h=>h.replace(/^##\s+/,'').trim());
    if(heads.length < 2) return '';
    return `<div class="hs-toc"><div class="hs-toc-inner">
      <h4>On this page</h4>
      <div class="hs-toc-list">
        ${heads.map(h=>`<a href="#${slugify(h)}">${escAttr(h)}</a>`).join('')}
      </div>
    </div></div>`;
  }
  function renderRevisions(a){
    const revs = (a.revisions||[]).slice().reverse();
    return `<div style="margin-bottom:18px;border:1px solid var(--border);border-radius:6px;padding:12px 14px;background:var(--panel);">
      <div class="hs-field-label">Revision history</div>
      ${revs.map((r,i)=>`<div class="hs-rev-item${i===0?' current':''}" style="flex-direction:column;align-items:stretch;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="hs-rev-meta">${i===0?'current | ':''}${escAttr(r.editor)} | ${new Date(r.timestamp).toLocaleString()}</span>
          <span class="hs-rev-actions">
            ${i===0 ? '' : `<button class="ghost" onclick="HS.toggleDiff(${r.id})">${STATE.diffOpenId===r.id?'Hide diff':'Diff vs current'}</button>`}
            ${i===0 ? '' : `<button class="ghost" onclick='HS.restoreRevision(${r.id})'>Restore</button>`}
          </span>
        </div>
        ${STATE.diffOpenId===r.id ? renderDiffPanel() : ''}
      </div>`).join('')}
    </div>`;
  }
  function renderDiffPanel(){
    if(STATE.diffLoading) return `<div class="hs-hint" style="margin-top:8px;">Loading diff...</div>`;
    if(!STATE.diffLines) return '';
    const hasChanges = STATE.diffLines.some(l=>l.type!=='same');
    if(!hasChanges) return `<div class="hs-hint" style="margin-top:8px;">No differences from the current version.</div>`;
    return `<div class="hs-diff" style="margin-top:8px;">${STATE.diffLines.map(l=>{
      const prefix = l.type==='add' ? '+ ' : l.type==='del' ? '- ' : '  ';
      const cls = l.type==='add' ? 'diff-add' : l.type==='del' ? 'diff-del' : 'diff-same';
      return `<span class="${cls}">${escAttr(prefix+l.text)}</span>`;
    }).join('')}</div>`;
  }
  function diffLines(oldText, newText){
    const oldL = oldText.split('\n'), newL = newText.split('\n');
    const m = oldL.length, n = newL.length;
    const dp = Array.from({length:m+1}, ()=>new Array(n+1).fill(0));
    for(let i=m-1;i>=0;i--) for(let j=n-1;j>=0;j--)
      dp[i][j] = oldL[i]===newL[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
    const result = [];
    let i=0, j=0;
    while(i<m && j<n){
      if(oldL[i]===newL[j]){ result.push({type:'same', text:oldL[i]}); i++; j++; }
      else if(dp[i+1][j] >= dp[i][j+1]){ result.push({type:'del', text:oldL[i]}); i++; }
      else { result.push({type:'add', text:newL[j]}); j++; }
    }
    while(i<m){ result.push({type:'del', text:oldL[i]}); i++; }
    while(j<n){ result.push({type:'add', text:newL[j]}); j++; }
    return result;
  }
  async function toggleDiff(revId){
    if(STATE.diffOpenId === revId){ STATE.diffOpenId = null; STATE.diffLines = null; render(); return; }
    STATE.diffOpenId = revId; STATE.diffLines = null; STATE.diffLoading = true;
    render();
    try{
      const data = await api('GET','/articles/'+encodeURIComponent(STATE.article.slug)+'/revisions/'+revId);
      STATE.diffLines = diffLines(data.revision.body, STATE.article.body);
      STATE.diffLoading = false;
      render();
    }catch(e){
      alert('Could not load that revision: '+e.message);
      STATE.diffOpenId = null; STATE.diffLoading = false;
      render();
    }
  }
  const MAX_INDENT = 5; // cap visual nesting depth so deep threads don't run off narrow screens
  function buildCommentTree(list){
    const byParent = {};
    list.forEach(c=>{
      const key = c.parentId || 'root';
      (byParent[key] = byParent[key] || []).push(c);
    });
    Object.values(byParent).forEach(arr => arr.sort((a,b)=>a.timestamp-b.timestamp));
    return byParent;
  }
  function renderCommentNode(c, byParent, depth){
    const children = byParent[c.id] || [];
    const indent = Math.min(depth, MAX_INDENT) * 20;
    const isDeleted = c.deleted;
    const canDelete = !isDeleted && (isMe(c.author) || isAdmin());
    const canBan = !isDeleted && isAdmin() && !isMe(c.author);
    const canReport = !isDeleted && STATE.user && !isMe(c.author);
    return `<div class="hs-comment" style="margin-left:${indent}px;">
      <div class="hs-comment-meta">
        <span>${isDeleted ? `<span class="mono" style="color:var(--text-faint);font-style:italic;">[deleted]</span>` : `<b class="mono" style="color:var(--accent);cursor:pointer;" onclick="HS.openProfile('${escAttr(c.author)}')">${escAttr(c.author)}</b>`} | ${timeAgo(c.timestamp)}</span>
        <span>
          ${(!isDeleted && STATE.user) ? `<button class="ghost" style="padding:2px 8px;font-size:11px;" onclick="HS.startReply(${c.id})">reply</button>` : ''}
          ${canReport ? `<button class="ghost" style="padding:2px 8px;font-size:11px;" onclick="HS.reportComment(${c.id})">report</button>` : ''}
          ${canDelete ? `<button class="danger-txt" onclick="HS.deleteComment(${c.id})">delete${(!isMe(c.author)&&isAdmin())?' (admin)':''}</button>` : ''}
          ${canBan ? `<button class="danger-txt" onclick="HS.banAuthor('${escAttr(c.author)}')">ban user</button>` : ''}
        </span>
      </div>
      <div class="hs-comment-body">${isDeleted ? '<span style="color:var(--text-faint);font-style:italic;">[deleted]</span>' : escAttr(c.body)}</div>
      ${STATE.replyingTo===c.id ? `
        <div style="margin-top:8px;">
          <textarea rows="2" placeholder="Write a reply..." oninput="HS.onReplyDraft(this.value)">${escAttr(STATE.replyDraft)}</textarea>
          <div class="hs-editor-actions">
            <button class="primary" onclick="HS.submitComment(${c.id})">Post reply</button>
            <button class="ghost" onclick="HS.cancelReply()">Cancel</button>
          </div>
        </div>` : ''}
      ${children.map(ch=>renderCommentNode(ch, byParent, depth+1)).join('')}
    </div>`;
  }
  function renderComments(){
    const visibleCount = STATE.comments.filter(c=>!c.deleted).length;
    const byParent = buildCommentTree(STATE.comments);
    const roots = byParent['root'] || [];
    return `<div class="hs-comments">
      <h3>${visibleCount} comment${visibleCount===1?'':'s'}</h3>
      ${roots.length ? roots.map(c=>renderCommentNode(c, byParent, 0)).join('') : `<div class="hs-empty">No comments yet.</div>`}
      ${STATE.user ? `
        <div style="margin-top:12px;">
          <textarea rows="3" placeholder="Add a comment - corrections, gotchas, alternate approaches..." oninput="HS.onCommentDraft(this.value)">${escAttr(STATE.commentDraft)}</textarea>
          <div class="hs-editor-actions"><button class="primary" onclick="HS.submitComment()">Post comment</button></div>
        </div>` : `<div class="hs-hint" style="margin-top:10px;"><a href="#" onclick="HS.openAuth('login');return false;">Sign in</a> to leave a comment.</div>`}
    </div>`;
  }
  function renderToolbar(){
    const btn = (type, label, title) => `<button title="${escAttr(title)}" onmousedown="event.preventDefault()" onclick="HS.tbAction('${type}')">${label}</button>`;
    return `<div class="hs-toolbar">
      ${btn('h1','H1','Heading 1')}
      ${btn('h2','H2','Heading 2')}
      ${btn('h3','H3','Heading 3')}
      <div class="hs-tb-sep"></div>
      ${btn('bold','<b>B</b>','Bold')}
      ${btn('italic','<i>I</i>','Italic')}
      ${btn('code','&lt;/&gt;','Inline code')}
      <div class="hs-tb-sep"></div>
      ${btn('ul','&bull; List','Bullet list')}
      ${btn('ol','1. List','Numbered list')}
      ${btn('quote','&rdquo; Quote','Blockquote')}
      <div class="hs-tb-sep"></div>
      ${btn('link','Link','Insert link')}
      ${btn('codeblock','Code Block','Code block')}
      <div class="hs-tb-sep"></div>
      <button title="Upload image" onmousedown="event.preventDefault()" onclick="document.getElementById('hs-image-input').click()">${STATE.uploadingImage?'Uploading...':'Image'}</button>
      <input id="hs-image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none;" onchange="HS.uploadImage(this)" />
    </div>`;
  }
  function renderEditor(isNew){
    const d = STATE.editDraft;
    return `<div class="hs-main">
      <div class="hs-breadcrumb">${isNew ? 'New article' : `<a href="#" onclick="HS.openArticle('${STATE.article.slug}');return false;">back to article</a>`}</div>
      <h2 style="margin-top:0;">${isNew ? 'Write a new article' : 'Edit article'}</h2>
      ${(STATE.user && !STATE.user.isTrusted) ? `<div class="hs-hint" style="margin-bottom:12px;">This is one of your first contributions, so it'll be held for a quick admin review before it goes live. After that, your edits publish immediately.</div>` : ''}
      <div class="hs-editor-grid">
        <div>
          <span class="hs-field-label">Title</span>
          <input type="text" value="${escAttr(d.title)}" oninput="HS.onDraft('title', this.value)" placeholder="e.g. Resetting a stuck FortiGate HA cluster" />
        </div>
        <div>
          <span class="hs-field-label">Category</span>
          <select onchange="HS.onCategoryChange(this.value)">
            ${CATEGORIES.map(c=>`<option value="${c.id}" ${d.category===c.id?'selected':''}>${c.label}</option>`).join('')}
            <option value="__new__" ${d.category==='__new__'?'selected':''}>+ Add new category...</option>
          </select>
          ${d.category==='__new__' ? `<input type="text" style="margin-top:8px;" value="${escAttr(d.newCategoryLabel)}" oninput="HS.onDraft('newCategoryLabel', this.value)" placeholder="e.g. Backups & Disaster Recovery" autofocus />` : ''}
        </div>
        <div>
          <span class="hs-field-label">Tags (comma-separated, optional)</span>
          <input type="text" value="${escAttr(d.tagsText)}" oninput="HS.onDraft('tagsText', this.value)" placeholder="e.g. bash, cron, troubleshooting" />
        </div>
        <div>
          <span class="hs-field-label">Body</span>
          <div class="hs-tabs">
            <button class="${STATE.editorTab==='write'?'active':''}" onclick="HS.setEditorTab('write')">Write</button>
            <button class="${STATE.editorTab==='preview'?'active':''}" onclick="HS.setEditorTab('preview')">Preview</button>
          </div>
          ${STATE.editorTab==='preview' ? `
          <div class="hs-body" style="border:1px solid var(--border);border-radius:6px;padding:14px 16px;min-height:200px;background:var(--panel);">${d.body.trim() ? mdToHtml(d.body) : '<span class="hs-hint">Nothing to preview yet.</span>'}</div>
          ` : `
          ${renderToolbar()}
          <textarea id="hs-body-textarea" class="hs-tb-textarea" rows="16" oninput="HS.onDraft('body', this.value)" placeholder="## Overview

What is this article about, and who's it for?

## Steps

- First...
- Then...">${escAttr(d.body)}</textarea>
          <div class="hs-hint">Or type markdown directly: **bold**, *italic*, \`code\`, \`\`\`code blocks\`\`\`, - lists, &gt; quotes, [links](url)</div>
          `}
        </div>
        ${STATE.banner && STATE.banner.type==='error' ? `<div class="hs-error">${escAttr(STATE.banner.text)}</div>` : ''}
        <div class="hs-editor-actions">
          <button class="primary" onclick="HS.${isNew?'submitNewArticle':'submitEdit'}()">${isNew ? 'Publish article' : 'Save changes'}</button>
          <button class="ghost" onclick="${isNew?'HS.goHome()':`HS.openArticle('${STATE.article.slug}')`}">Cancel</button>
        </div>
      </div>
    </div>`;
  }
  function renderAdminPage(){
    if(!isAdmin()){
      return `<div class="hs-main"><div class="hs-empty">Admin access required.</div></div>`;
    }
    if(STATE.adminLoadError){
      return `<div class="hs-main"><div class="hs-empty">Couldn't load the user list.<br><br>
        <button class="primary" onclick="HS.goAdmin()">Try again</button>
      </div></div>`;
    }
    if(!STATE.adminUsers){
      return `<div class="hs-main"><div class="hs-empty">Loading...</div></div>`;
    }
    const rows = STATE.adminUsers.map(u => {
      let statusTag;
      if(u.banned) statusTag = `<span class="hs-tag locked">banned</span>`;
      else if(u.isAdmin) statusTag = `<span class="hs-admin-badge" style="cursor:default;">admin</span>`;
      else if(!u.isTrusted) statusTag = `<span class="hs-tag" style="border-color:var(--accent-line);color:var(--accent);">new</span>`;
      else statusTag = `<span class="hs-tag">active</span>`;

      let action;
      if(u.isAdmin){
        action = `<button class="ghost" onclick="HS.toggleAdmin('${escAttr(u.username)}', true)">Demote</button>`;
      }else if(u.banned){
        action = `<button class="ghost" onclick="HS.toggleBan('${escAttr(u.username)}', true)">Unban</button>`;
      }else{
        action = `<button class="ghost" style="margin-right:4px;" onclick="HS.toggleAdmin('${escAttr(u.username)}', false)">Promote</button>`
          + `<button class="danger-txt" style="border:1px solid var(--border);" onclick="HS.toggleBan('${escAttr(u.username)}', false)">Ban</button>`;
      }

      return `<tr>
        <td>${escAttr(u.username)}</td>
        <td>${statusTag}</td>
        <td class="mono" style="color:var(--text-faint);">${new Date(u.createdAt).toLocaleDateString()}</td>
        <td class="mono" style="color:var(--text-dim);">${u.articlesCreated}</td>
        <td class="mono" style="color:var(--text-dim);">${u.editsMade}</td>
        <td class="mono" style="color:var(--text-dim);">${u.commentsPosted}</td>
        <td class="mono" style="color:${u.rejectedCount>0?'var(--danger)':'var(--text-dim)'};">${u.rejectedCount}</td>
        <td class="mono" style="color:${u.commentsRemoved>0?'var(--danger)':'var(--text-dim)'};">${u.commentsRemoved}</td>
        <td>${action}</td>
      </tr>`;
    }).join('');

    return `<div class="hs-main">
      <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / Admin</div>
      <div class="hs-list-head"><h2>Manage users</h2><div style="display:flex;gap:8px;"><button class="ghost" onclick="HS.toggleCreateUserForm()">${STATE.showCreateUserForm?'Cancel':'+ Create user'}</button><button class="ghost" onclick="HS.goBackupSettings()">Backup settings</button></div></div>
      ${STATE.showCreateUserForm ? `
        <div class="hs-related" style="margin-top:0;">
          <h4>Create a local account</h4>
          <div class="hs-editor-grid" style="max-width:380px;">
            <div><span class="hs-field-label">Username</span><input type="text" value="${escAttr(STATE.newUserDraft.username)}" oninput="HS.onNewUserDraft('username', this.value)" placeholder="e.g. jsmith" /></div>
            <div><span class="hs-field-label">Password</span><input type="password" value="${escAttr(STATE.newUserDraft.password)}" oninput="HS.onNewUserDraft('password', this.value)" placeholder="At least 6 characters" /></div>
            <div><span class="hs-field-label">Email (optional)</span><input type="text" value="${escAttr(STATE.newUserDraft.email)}" oninput="HS.onNewUserDraft('email', this.value)" placeholder="pre-marked as verified" /></div>
            <div><label style="display:flex;align-items:center;gap:8px;font-size:13.5px;cursor:pointer;"><input type="checkbox" style="width:auto;" ${STATE.newUserDraft.isAdmin?'checked':''} onchange="HS.onNewUserDraft('isAdmin', this.checked)" /> Make this account an admin</label></div>
            ${STATE.createUserBanner ? `<div class="${STATE.createUserBanner.type==='error'?'hs-error':'hs-hint'}" style="${STATE.createUserBanner.type==='ok'?'color:var(--ok);':''}">${escAttr(STATE.createUserBanner.text)}</div>` : ''}
            <div class="hs-editor-actions"><button class="primary" onclick="HS.submitCreateUser()">Create account</button></div>
          </div>
        </div>` : ''}
      <div class="hs-hint" style="margin-bottom:14px;">${STATE.adminUsers.length} account${STATE.adminUsers.length===1?'':'s'} total. "Rejected" counts submissions turned down in the review queue; "Removed" counts comments an admin took down (not the user's own deletions). Admins can't be banned directly - demote first if that's ever needed. The last remaining admin can't be demoted, to avoid locking everyone out.</div>
      <div style="overflow-x:auto;">
        <table class="hs-admin-table">
          <thead><tr>
            <th>Username</th><th>Status</th><th>Joined</th><th>Articles</th><th>Edits</th><th>Comments</th><th>Rejected</th><th>Removed</th><th>Action</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }
  function renderAccount(){
    if(!STATE.user) return `<div class="hs-main"><div class="hs-empty">Sign in required.</div></div>`;
    const u = STATE.user;
    const banner = STATE.accountBanner ? `<div class="${STATE.accountBanner.type==='error'?'hs-error':'hs-hint'}" style="${STATE.accountBanner.type==='ok'?'color:var(--ok);':''}margin-bottom:12px;">${escAttr(STATE.accountBanner.text)}</div>` : '';

    let emailSection;
    if(u.email && u.emailVerified){
      emailSection = `<div class="hs-hint">Verified: <b style="color:var(--text);">${escAttr(u.email)}</b></div>`;
    }else if(u.email && !u.emailVerified){
      emailSection = `
        <div class="hs-hint" style="margin-bottom:8px;">A code was sent to <b style="color:var(--text);">${escAttr(u.email)}</b> - enter it below to verify.</div>
        <div style="display:flex;gap:8px;">
          <input id="hs-verify-code" type="text" placeholder="6-digit code" style="max-width:160px;" onkeydown="if(event.key==='Enter'){HS.submitVerifyEmailCode();}" />
          <button class="primary" onclick="HS.submitVerifyEmailCode()">Verify</button>
          <button class="ghost" onclick="HS.resendVerificationCode()">Resend code</button>
        </div>`;
    }else{
      emailSection = `
        <div class="hs-hint" style="margin-bottom:8px;">No email on file yet.</div>
        <div style="display:flex;gap:8px;">
          <input type="text" placeholder="you@example.com" style="max-width:240px;" value="${escAttr(STATE.emailInput)}" oninput="HS.onEmailInput(this.value)" onkeydown="if(event.key==='Enter'){HS.submitSetEmail();}" />
          <button class="primary" onclick="HS.submitSetEmail()">Send code</button>
        </div>`;
    }

    let twoFaSection;
    if(u.totpEnabled){
      twoFaSection = `<div class="hs-hint" style="margin-bottom:10px;">Two-factor authentication is <b style="color:var(--ok);">on</b>.</div>
        <button class="ghost" onclick="HS.disableTotp()">Disable 2FA</button>`;
    }else if(STATE.twoFaSetup){
      twoFaSection = `
        <div class="hs-hint" style="margin-bottom:10px;">Scan this with Google Authenticator, Authy, or similar, then enter the 6-digit code it shows.</div>
        <img src="${STATE.twoFaSetup.qrDataUrl}" alt="2FA QR code" style="width:180px;height:180px;border:1.5px solid var(--border);margin-bottom:10px;display:block;" />
        <div class="hs-hint" style="margin-bottom:10px;">Can't scan? Enter manually: <span class="mono">${escAttr(STATE.twoFaSetup.secret)}</span></div>
        <div style="display:flex;gap:8px;">
          <input type="text" placeholder="6-digit code" style="max-width:160px;" value="${escAttr(STATE.twoFaCodeInput)}" oninput="HS.onTwoFaCodeInput(this.value)" onkeydown="if(event.key==='Enter'){HS.confirmTotpSetup();}" />
          <button class="primary" onclick="HS.confirmTotpSetup()">Confirm & enable</button>
          <button class="ghost" onclick="HS.goAccount()">Cancel</button>
        </div>`;
    }else{
      twoFaSection = `<div class="hs-hint" style="margin-bottom:10px;">Off. Add an authenticator app for an extra layer of protection on sign-in.</div>
        <button class="primary" onclick="HS.startTotpSetup()">Set up 2FA</button>`;
    }

    return `<div class="hs-main" style="max-width:480px;">
      <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / Account</div>
      <div class="hs-list-head"><h2>${escAttr(u.username)}</h2></div>
      ${banner}
      <div class="hs-related" style="margin-top:0;">
        <h4>Email</h4>
        ${emailSection}
      </div>
      <div class="hs-related">
        <h4>Two-factor authentication</h4>
        ${twoFaSection}
      </div>
    </div>`;
  }
  function renderBackupSettings(){
    if(!isAdmin()) return `<div class="hs-main"><div class="hs-empty">Admin access required.</div></div>`;
    if(STATE.backupLoadError){
      return `<div class="hs-main"><div class="hs-empty">Couldn't load backup settings.<br><br>
        <button class="primary" onclick="HS.goBackupSettings()">Try again</button>
      </div></div>`;
    }
    if(!STATE.backupSettings) return `<div class="hs-main"><div class="hs-empty">Loading...</div></div>`;
    const s = STATE.backupSettings, d = STATE.backupDraft;
    const lastRun = s.lastBackupAt
      ? `${new Date(s.lastBackupAt).toLocaleString()} - ${s.lastBackupStatus==='ok' ? 'succeeded' : 'failed'}${s.lastBackupStatus!=='ok' && s.lastBackupError ? ' ('+escAttr(s.lastBackupError)+')' : ''}`
      : 'never run yet';
    return `<div class="hs-main">
      <div class="hs-breadcrumb"><a href="#" onclick="HS.goAdmin();return false;">manage users</a> / Backup settings</div>
      <div class="hs-list-head"><h2>S3 backup settings</h2></div>
      <div class="hs-hint" style="margin-bottom:16px;">Off-server backups of your database to an S3 bucket. Credentials are stored server-side and never sent back to the browser - leave the key fields blank when saving to keep what's already there.</div>
      <div class="hs-editor-grid" style="max-width:480px;">
        <div>
          <span class="hs-field-label">Bucket name</span>
          <input type="text" value="${escAttr(d.bucket)}" oninput="HS.onBackupDraft('bucket', this.value)" placeholder="e.g. runbookit-backups" />
        </div>
        <div>
          <span class="hs-field-label">Region</span>
          <input type="text" value="${escAttr(d.region)}" oninput="HS.onBackupDraft('region', this.value)" placeholder="e.g. us-east-1" />
        </div>
        <div>
          <span class="hs-field-label">Access key ID ${s.hasCredentials?'(already set - leave blank to keep it)':''}</span>
          <input type="text" value="${escAttr(d.accessKeyId)}" oninput="HS.onBackupDraft('accessKeyId', this.value)" placeholder="${s.hasCredentials?'unchanged':'AKIA...'}" />
        </div>
        <div>
          <span class="hs-field-label">Secret access key ${s.hasCredentials?'(already set - leave blank to keep it)':''}</span>
          <input type="password" value="${escAttr(d.secretAccessKey)}" oninput="HS.onBackupDraft('secretAccessKey', this.value)" placeholder="${s.hasCredentials?'unchanged':''}" />
        </div>
        <div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;cursor:pointer;">
            <input type="checkbox" style="width:auto;" ${d.autoEnabled?'checked':''} onchange="HS.onBackupDraft('autoEnabled', this.checked)" />
            Run automatically once a day
          </label>
        </div>
        ${STATE.backupBanner ? `<div class="${STATE.backupBanner.type==='error'?'hs-error':'hs-hint'}" style="${STATE.backupBanner.type==='ok'?'color:var(--ok);':''}">${escAttr(STATE.backupBanner.text)}</div>` : ''}
        <div class="hs-editor-actions">
          <button class="primary" onclick="HS.saveBackupSettings()" ${STATE.backupSaving?'disabled':''}>${STATE.backupSaving?'Saving...':'Save settings'}</button>
          <button class="ghost" onclick="HS.runBackupNow()" ${STATE.backupRunning?'disabled':''}>${STATE.backupRunning?'Backing up...':'Back up now'}</button>
        </div>
        <div class="hs-hint">Last run: ${lastRun}</div>
      </div>
    </div>`;
  }
  function renderReviewQueue(){
    if(!isAdmin()){
      return `<div class="hs-main"><div class="hs-empty">Admin access required.</div></div>`;
    }
    if(STATE.pendingLoadError){
      return `<div class="hs-main"><div class="hs-empty">Couldn't load the review queue.<br><br>
        <button class="primary" onclick="HS.goReview()">Try again</button>
      </div></div>`;
    }
    if(!STATE.pendingList){
      return `<div class="hs-main"><div class="hs-empty">Loading...</div></div>`;
    }
    if(!STATE.pendingList.length){
      return `<div class="hs-main">
        <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / Review queue</div>
        <div class="hs-list-head"><h2>Review queue</h2></div>
        <div class="hs-empty">Nothing waiting on review right now.</div>
      </div>`;
    }
    const items = STATE.pendingList.map(p => `<div class="hs-card" style="cursor:default;">
      <p class="hs-card-title">${p.type==='new_article' ? 'New article' : 'Edit to an existing article'}: ${escAttr(p.title)}</p>
      <div class="hs-card-meta" style="margin-bottom:10px;">
        <span class="hs-tag">${catLabel(p.category)}</span>
        <span>by ${escAttr(p.author)}</span>
        <span>submitted ${timeAgo(p.createdAt)}</span>
        ${p.type==='edit' ? `<a href="#" onclick="HS.openArticle('${p.articleSlug}');return false;">view current live version</a>` : ''}
      </div>
      <div class="hs-body" style="border:1px solid var(--border);border-radius:6px;padding:12px 14px;background:var(--panel-2);max-height:320px;overflow-y:auto;">${mdToHtml(p.body)}</div>
      <div class="hs-editor-actions" style="margin-top:12px;">
        <button class="primary" onclick="HS.approvePending(${p.id})">Approve & publish</button>
        <button class="danger-txt" style="border:1px solid var(--border);" onclick="HS.rejectPending(${p.id})">Reject</button>
      </div>
    </div>`).join('');
    return `<div class="hs-main">
      <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / Review queue</div>
      <div class="hs-list-head"><h2>Review queue</h2></div>
      <div class="hs-hint" style="margin-bottom:14px;">${STATE.pendingList.length} submission${STATE.pendingList.length===1?'':'s'} from new accounts, held for review. Approving publishes it immediately and trusts that account for future contributions.</div>
      ${items}
    </div>`;
  }
  function renderSubmitted(){
    return `<div class="hs-main">
      <div class="hs-hero">
        <h1>Submitted for review</h1>
        <p>${escAttr(STATE.submittedMessage||'Your submission is awaiting admin review.')}</p>
      </div>
      <button class="primary" onclick="HS.goHome()">Back to all articles</button>
    </div>`;
  }
  function renderProfile(){
    if(STATE.profileLoadError){
      return `<div class="hs-main"><div class="hs-empty">Couldn't load that profile.<br><br>
        <button class="primary" onclick="HS.openProfile('${escAttr(STATE.view.username)}')">Try again</button>
      </div></div>`;
    }
    if(!STATE.profileData) return `<div class="hs-main"><div class="hs-empty">Loading...</div></div>`;
    const p = STATE.profileData;
    return `<div class="hs-main">
      <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / Profile</div>
      <div class="hs-list-head"><h2>${escAttr(p.username)}${p.isAdmin?`<span class="hs-admin-badge" style="margin-left:8px;">admin</span>`:''}</h2></div>
      <div class="hs-hint" style="margin-bottom:16px;">Joined ${new Date(p.joinedAt).toLocaleDateString()} - ${p.articles.length} article${p.articles.length===1?'':'s'} created, ${p.editsMade} edit${p.editsMade===1?'':'s'} made, ${p.commentsPosted} comment${p.commentsPosted===1?'':'s'} posted.</div>
      ${p.articles.length ? `<h4 style="font-size:13px;color:var(--text-dim);">Articles created</h4>
        ${p.articles.map(a=>`<div class="hs-card" onclick="HS.openArticle('${a.slug}')">
          <p class="hs-card-title">${escAttr(a.title)}</p>
          <div class="hs-card-meta"><span>updated ${timeAgo(a.updatedAt)}</span></div>
        </div>`).join('')}` : `<div class="hs-empty">No articles created yet.</div>`}
    </div>`;
  }
  function renderLeaderboard(){
    if(!STATE.leaderboard) return `<div class="hs-main"><div class="hs-empty">Loading...</div></div>`;
    if(!STATE.leaderboard.length) return `<div class="hs-main"><div class="hs-empty">No contributions yet - be the first.</div></div>`;
    return `<div class="hs-main">
      <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / Leaderboard</div>
      <div class="hs-list-head"><h2>Top contributors</h2></div>
      ${STATE.leaderboard.map((u,i)=>`<div class="hs-card" onclick="HS.openProfile('${escAttr(u.username)}')" style="display:flex;align-items:center;justify-content:space-between;">
        <div><span class="mono" style="color:var(--text-faint);margin-right:10px;">#${i+1}</span><b>${escAttr(u.username)}</b></div>
        <div class="hs-card-meta"><span>${u.articles} article${u.articles===1?'':'s'}</span><span>${u.edits} edit${u.edits===1?'':'s'}</span></div>
      </div>`).join('')}
    </div>`;
  }
  function renderBookmarks(){
    if(!STATE.bookmarksList) return `<div class="hs-main"><div class="hs-empty">Loading...</div></div>`;
    if(!STATE.bookmarksList.length) return `<div class="hs-main">
      <div class="hs-list-head"><h2>My Bookmarks</h2></div>
      <div class="hs-empty">No bookmarks yet - open an article and click "Bookmark" to save it here.</div>
    </div>`;
    return `<div class="hs-main">
      <div class="hs-list-head"><h2>My Bookmarks</h2></div>
      ${STATE.bookmarksList.map(a=>`<div class="hs-card" onclick="HS.openArticle('${a.slug}')">
        <p class="hs-card-title">${escAttr(a.title)}</p>
        <p class="hs-card-excerpt">${escAttr(a.excerpt)}</p>
        <div class="hs-card-meta"><span class="hs-tag">${catLabel(a.category)}</span><span>updated ${timeAgo(a.updatedAt)}</span></div>
      </div>`).join('')}
    </div>`;
  }
  function renderReportsQueue(){
    if(!isAdmin()) return `<div class="hs-main"><div class="hs-empty">Admin access required.</div></div>`;
    if(STATE.reportsLoadError){
      return `<div class="hs-main"><div class="hs-empty">Couldn't load reports.<br><br>
        <button class="primary" onclick="HS.goReports()">Try again</button>
      </div></div>`;
    }
    if(!STATE.reportsList) return `<div class="hs-main"><div class="hs-empty">Loading...</div></div>`;
    if(!STATE.reportsList.length){
      return `<div class="hs-main">
        <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / Reports</div>
        <div class="hs-list-head"><h2>Reports</h2></div>
        <div class="hs-empty">Nothing reported right now.</div>
      </div>`;
    }
    const items = STATE.reportsList.map(r => {
      let targetHtml;
      if(r.targetType==='article'){
        targetHtml = r.target
          ? `<a href="#" onclick="HS.openArticle('${r.target.slug}');return false;">${escAttr(r.target.title)}</a>`
          : `<span class="hs-hint">(article no longer exists)</span>`;
      }else{
        targetHtml = r.target
          ? `Comment by <b>${escAttr(r.target.author)}</b> on <a href="#" onclick="HS.openArticle('${r.target.articleSlug}');return false;">${escAttr(r.target.articleTitle||'an article')}</a>: <span class="hs-comment-body" style="display:block;margin-top:6px;">${escAttr(r.target.body)}</span>`
          : `<span class="hs-hint">(comment no longer exists)</span>`;
      }
      return `<div class="hs-card" style="cursor:default;">
        <p class="hs-card-title">${r.targetType==='article'?'Article reported':'Comment reported'}</p>
        <div class="hs-card-meta" style="margin-bottom:8px;">
          <span>by ${escAttr(r.reporter)}</span><span>${timeAgo(r.createdAt)}</span>
        </div>
        <div class="hs-body" style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;background:var(--panel-2);margin-bottom:10px;">
          <div class="hs-field-label">Reason</div>
          <div style="margin-bottom:10px;">${escAttr(r.reason)}</div>
          <div class="hs-field-label">Target</div>
          <div>${targetHtml}</div>
        </div>
        <button class="ghost" onclick="HS.dismissReport(${r.id})">Dismiss</button>
      </div>`;
    }).join('');
    return `<div class="hs-main">
      <div class="hs-breadcrumb"><a href="#" onclick="HS.goHome();return false;">all articles</a> / Reports</div>
      <div class="hs-list-head"><h2>Reports</h2></div>
      <div class="hs-hint" style="margin-bottom:14px;">${STATE.reportsList.length} open report${STATE.reportsList.length===1?'':'s'}. Dismissing just clears the report - use the existing lock/ban/delete tools separately if action is needed.</div>
      ${items}
    </div>`;
  }
  function renderNotifDropdown(){
    return `<div class="hs-overlay" style="background:transparent;align-items:flex-start;justify-content:flex-end;padding-top:56px;padding-right:20px;" onclick="if(event.target===this) HS.toggleNotifDropdown();">
      <div class="hs-modal" style="max-width:320px;padding:0;max-height:400px;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--border);">
          <b style="font-size:13px;">Notifications</b>
          ${STATE.notifications.some(n=>!n.read) ? `<button class="ghost" style="padding:2px 8px;font-size:11px;" onclick="HS.markAllNotifsRead()">Mark all read</button>` : ''}
        </div>
        ${STATE.notifications.length ? STATE.notifications.map(n=>`
          <div onclick='HS.openNotification(${JSON.stringify(n).replace(/'/g,"&#39;")})' style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;background:${n.read?'transparent':'var(--panel-2)'};">
            <div style="font-size:12.5px;color:var(--text);">${escAttr(n.message)}</div>
            <div class="hs-hint" style="margin-top:3px;">${timeAgo(n.createdAt)}</div>
          </div>
        `).join('') : `<div class="hs-hint" style="padding:16px;text-align:center;">No notifications yet.</div>`}
      </div>
    </div>`;
  }
  function renderAuthModal(){
    if(!STATE.authModal) return '';
    if(STATE.totpChallenge){
      return `<div class="hs-overlay" onclick="if(event.target===this) HS.closeAuth();">
        <div class="hs-modal">
          <h3>Two-factor code</h3>
          <div class="sub">Enter the 6-digit code from your authenticator app.</div>
          <div class="hs-modal-field"><span class="hs-field-label">Code</span><input id="hs-totp-code" type="text" inputmode="numeric" placeholder="123456" onkeydown="if(event.key==='Enter'){HS.submitTotpChallenge();}" /></div>
          ${STATE.authError ? `<div class="hs-error">${escAttr(STATE.authError)}</div>` : ''}
          <div class="hs-modal-actions">
            <span></span>
            <div style="display:flex;gap:8px;">
              <button class="ghost" onclick="HS.closeAuth()">Cancel</button>
              <button class="primary" onclick="HS.submitTotpChallenge()">Verify</button>
            </div>
          </div>
        </div>
      </div>`;
    }
    const isLogin = STATE.authModal==='login';
    return `<div class="hs-overlay" onclick="if(event.target===this) HS.closeAuth();">
      <div class="hs-modal">
        <h3>${isLogin?'Sign in':'Create an account'}</h3>
        <div class="sub">${isLogin? 'Sign in to edit articles and comment.' : 'Passwords are hashed and stored on the server. Use a real password if you want, but this is a small community tool, not a bank.'}</div>
        <div class="hs-modal-field"><span class="hs-field-label">Username</span><input id="hs-auth-user" type="text" placeholder="e.g. zack" onkeydown="if(event.key==='Enter'){HS.submitAuth();}" /></div>
        <div class="hs-modal-field"><span class="hs-field-label">Password</span><input id="hs-auth-pass" type="password" placeholder="At least 6 characters" onkeydown="if(event.key==='Enter'){HS.submitAuth();}" /></div>
        ${!isLogin ? `<div class="hs-modal-field"><span class="hs-field-label">Email (optional)</span><input id="hs-auth-email" type="text" placeholder="for account verification" onkeydown="if(event.key==='Enter'){HS.submitAuth();}" /></div>` : ''}
        ${(!isLogin && STATE.turnstileSiteKey) ? `<div class="hs-modal-field"><div class="cf-turnstile" data-sitekey="${escAttr(STATE.turnstileSiteKey)}" data-callback="onTurnstileSuccess"></div></div>` : ''}
        ${STATE.authError ? `<div class="hs-error">${escAttr(STATE.authError)}</div>` : ''}
        <div class="hs-modal-actions">
          <button class="switch hs-switch" onclick="HS.openAuth('${isLogin?'signup':'login'}')">${isLogin? "Need an account? Sign up" : "Already have one? Sign in"}</button>
          <div style="display:flex;gap:8px;">
            <button class="ghost" onclick="HS.closeAuth()">Cancel</button>
            <button class="primary" onclick="HS.submitAuth()">${isLogin?'Sign in':'Sign up'}</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function render(){
    if(!STATE.booted){
      root.innerHTML = STATE.bootError
        ? `<div style="padding:60px;text-align:center;color:var(--text-faint);font-family:var(--mono);">
             Could not reach the server. <button class="primary" onclick="HS.boot()">Retry</button>
           </div>`
        : `<div style="padding:60px;text-align:center;color:var(--text-faint);font-family:var(--mono);">booting runbookIT.wiki...</div>`;
      return;
    }
    let mainHtml;
    if(STATE.view.name==='home') mainHtml = renderHome();
    else if(STATE.view.name==='article') mainHtml = renderArticle();
    else if(STATE.view.name==='new') mainHtml = renderEditor(true);
    else if(STATE.view.name==='edit') mainHtml = renderEditor(false);
    else if(STATE.view.name==='admin') mainHtml = renderAdminPage();
    else if(STATE.view.name==='backup') mainHtml = renderBackupSettings();
    else if(STATE.view.name==='account') mainHtml = renderAccount();
    else if(STATE.view.name==='review') mainHtml = renderReviewQueue();
    else if(STATE.view.name==='submitted') mainHtml = renderSubmitted();
    else if(STATE.view.name==='profile') mainHtml = renderProfile();
    else if(STATE.view.name==='leaderboard') mainHtml = renderLeaderboard();
    else if(STATE.view.name==='bookmarks') mainHtml = renderBookmarks();
    else if(STATE.view.name==='reports') mainHtml = renderReportsQueue();
    else mainHtml = renderHome();

    root.innerHTML = `
      ${renderStatusBar()}
      ${renderNav()}
      <div class="hs-layout${STATE.view.name==='article' && STATE.article ? ' with-rail' : ''}">
        ${renderSidebar()}
        ${mainHtml}
        ${STATE.view.name==='article' ? renderToc() : ''}
      </div>
      ${renderAuthModal()}
    `;
  }

  window.onTurnstileSuccess = function(token){ STATE.turnstileToken = token; };

  window.HS = {
    goHome, goNew, goEdit, openArticle,
    setCategory(id){ STATE.category=id; STATE.tagFilter=null; STATE.search=''; STATE.searchResults=null; STATE.view={name:'home'}; render(); },
    setTagFilter(tag){ STATE.tagFilter=tag; STATE.category=null; STATE.search=''; STATE.searchResults=null; STATE.view={name:'home'}; render(); },
    onSearch(v){ STATE.search=v; if(STATE.view.name!=='home') STATE.view={name:'home'}; runSearch(v); },
    openAuth(mode){ STATE.authModal=mode; STATE.authError=''; STATE.totpChallenge=null; STATE.turnstileToken=null; render();
      setTimeout(()=>{ const el=document.getElementById('hs-auth-user'); if(el) el.focus(); },0);
    },
    closeAuth(){ STATE.authModal=null; STATE.authError=''; STATE.totpChallenge=null; STATE.turnstileToken=null; render(); },
    submitAuth, submitTotpChallenge, logout: doLogout,
    onDraft(field, val){ STATE.editDraft[field]=val; },
    onCategoryChange(val){ STATE.editDraft.category=val; STATE.editDraft.newCategoryLabel=''; render(); },
    submitNewArticle, submitEdit,
    toggleRevisions(){ STATE.showRevisions = !STATE.showRevisions; render(); },
    restoreRevision, toggleLock, banAuthor, toggleDiff,
    onCommentDraft(v){ STATE.commentDraft=v; },
    submitComment, deleteComment,
    startReply(id){ STATE.replyingTo=id; STATE.replyDraft=''; render(); },
    cancelReply(){ STATE.replyingTo=null; STATE.replyDraft=''; render(); },
    onReplyDraft(v){ STATE.replyDraft=v; },
    tbAction, copyCode, uploadImage,
    castVote,
    goAdmin, toggleBan, toggleAdmin,
    goBackupSettings, saveBackupSettings, runBackupNow,
    goAccount, submitSetEmail, submitVerifyEmailCode, resendVerificationCode,
    startTotpSetup, confirmTotpSetup, disableTotp,
    onEmailInput(v){ STATE.emailInput=v; },
    onTwoFaCodeInput(v){ STATE.twoFaCodeInput=v; },
    toggleCreateUserForm, submitCreateUser,
    onNewUserDraft(field, val){ STATE.newUserDraft[field]=val; },
    onBackupDraft(field, val){ STATE.backupDraft[field]=val; },
    goReview, approvePending, rejectPending,
    goReports, dismissReport,
    toggleNotifDropdown, openNotification, markAllNotifsRead,
    toggleBookmark, exportMarkdown, reportArticle, reportComment,
    openProfile, goLeaderboard, goBookmarks,
    setEditorTab(tab){ STATE.editorTab = tab; render(); },
    boot,
  };

  async function boot(){
    STATE.booted = false; STATE.bootError = false; render();
    try{
      await Promise.all([loadIndex(), loadCategories()]);
      try{ const cfg = await api('GET','/config'); STATE.turnstileSiteKey = cfg.turnstileSiteKey; }catch(e){}
      const me = await api('GET','/auth/me');
      STATE.user = me.user || null;
      STATE.booted = true;
      render();
      if(STATE.user && STATE.user.isAdmin){ refreshPendingCount(); refreshReportCount(); }
      if(STATE.user) loadNotifications();
    }catch(e){
      console.error('boot failed', e);
      STATE.bootError = true;
      render();
    }
  }
  boot();
})();
