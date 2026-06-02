/* ============================
   FOCAL INDIA SEAT BOOKING
   Fixed: Supabase is now the single source of truth.
   All reads come from Supabase. localStorage is only a
   local cache so the UI can render instantly on re-visits.
   Realtime subscriptions cover bookings, blocked, AND holidays.
============================= */

var SUPABASE_URL = 'https://oxazhkjnbaixmhwdwlkw.supabase.co';
var SUPABASE_KEY = 'sb_publishable_4rzT7Sbg4AG7zsUrVQUozg_0LbAHOEV';
var _sb = null;

var KEYS = {
  bookings:  'seatbooking_bookings',
  blocked:   'seatbooking_blocked',
  holidays:  'seatbooking_holidays',
  resources: 'seatbooking_resources',
  layoutImg: 'seatbooking_layout_img',
  adminLoggedIn: 'seatbooking_admin'
};

/* --- SUPABASE CORE --- */
function initSupabase() {
  try {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      return true;
    }
    return false;
  } catch(e) { return false; }
}

var _syncTimer = null;
function debouncedSync() {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(function() { syncAllFromSupabase(); }, 400);
}

/* 
  FIX: syncAllFromSupabase fetches bookings + blocked + holidays together.
  renderTable() is only called AFTER Supabase responds, so Supabase always wins.
*/
function syncAllFromSupabase() {
  if (!_sb) return;
  Promise.all([
    _sb.from('bookings').select('seat,date,initials'),
    _sb.from('blocked').select('seat,date'),
    _sb.from('holidays').select('date,name')
  ]).then(function(results) {
    if (!results[0].error) setData(KEYS.bookings, results[0].data || []);
    if (!results[1].error) setData(KEYS.blocked, results[1].data || []);
    if (!results[2].error) setData(KEYS.holidays, results[2].data || []);
    renderTable();
    var adminPage = document.getElementById('adminPage');
    if (adminPage && adminPage.classList.contains('active')) {
      renderAdminBookings();
      renderAdminHolidays();
    }
  });
}

/* Legacy alias used in a few places */
function syncFromSupabase() { syncAllFromSupabase(); }

function syncResourcesFromSupabase() {
  if (!_sb) return;
  _sb.from('resources').select('*').then(function(res) {
    if (!res.error && res.data && res.data.length > 0) {
      setData(KEYS.resources, res.data);
      renderResources();
      renderAdminResources();
    }
  });
}

/* FIX: Subscribe to ALL three tables, not just bookings */
function sbSubscribeAll() {
  if (!_sb) return;
  var tables = ['bookings', 'blocked', 'holidays'];
  for (var i = 0; i < tables.length; i++) {
    (function(tbl) {
      try {
        _sb.channel(tbl + '-realtime')
          .on('postgres_changes', { event: '*', schema: 'public', table: tbl }, function() {
            debouncedSync();
          })
          .subscribe();
      } catch(e) {}
    })(tables[i]);
  }
  try {
    _sb.channel('res-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'resources' }, function() {
        syncResourcesFromSupabase();
      })
      .subscribe();
  } catch(e) {}
}

/* --- STORAGE HELPERS (localStorage as cache only) --- */
var _memStore = {};
var _lsAvailable = false;
(function() { try { var t='_t'; localStorage.setItem(t,t); localStorage.removeItem(t); _lsAvailable=true; } catch(e){ _lsAvailable=false; } })();
function getData(key) {
  try {
    var raw = _lsAvailable ? localStorage.getItem(key) : _memStore[key];
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) { return []; }
}
function setData(key, val) {
  try {
    var str = JSON.stringify(val);
    if (_lsAvailable) { localStorage.setItem(key, str); } else { _memStore[key] = str; }
  } catch(e) {}
}
function getDataRaw(k) { try { return _lsAvailable ? localStorage.getItem(k) : _memStore[k]; } catch(e){return null;} }
function setDataRaw(k, v) { try { if(_lsAvailable) localStorage.setItem(k,v); else _memStore[k]=v; } catch(e){} }

/* --- DATE HELPERS --- */
function getMonday(d) {
  var dt = new Date(d);
  var day = dt.getDay(), diff = (day === 0) ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff); dt.setHours(0,0,0,0);
  return dt;
}
function addDays(d, n) { var dt = new Date(d); dt.setDate(dt.getDate() + n); return dt; }
function formatDate(d) {
  var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return (d.getDate() < 10 ? '0' : '') + d.getDate() + ' ' + m[d.getMonth()];
}
function isoDate(d) {
  var y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
}

/* --- UI STATE --- */
var currentWeekStart = null, pendingCell = null, manageCell = null, selectedDateStr = null;
var SEATS = (function() { var a=[]; for(var i=1;i<=31;i++) a.push('S'+(i<10?'0':'')+i); return a; })();
var DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
var PERMANENT_BLOCKED_SEATS = ['S01', 'S15', 'S21', 'S26'];
var PERMANENT_BLOCK_UNTIL = '2026-12-31';

function isPermanentlyBlocked(seat, dateStr) {
  if (PERMANENT_BLOCKED_SEATS.indexOf(seat) === -1) return false;
  return dateStr <= PERMANENT_BLOCK_UNTIL;
}

/* --- RENDER TABLE --- */
function renderTable() {
  try {
    if (!currentWeekStart) currentWeekStart = getMonday(new Date());
    var bookings = getData(KEYS.bookings), blocked = getData(KEYS.blocked), holidays = getData(KEYS.holidays);
    var todayStr = isoDate(new Date());
    var weekDates = [];
    for (var i = 0; i < 7; i++) { weekDates.push(addDays(currentWeekStart, i)); }

    if (!selectedDateStr) {
      selectedDateStr = isoDate(weekDates[0]);
      for (var wi = 0; wi < weekDates.length; wi++) {
        if (isoDate(weekDates[wi]) === todayStr) { selectedDateStr = todayStr; break; }
      }
    }

    var head = document.getElementById('tableHeader');
    if (head) {
        head.innerHTML = '<th>Seat</th>';
        for (var di = 0; di < weekDates.length; di++) {
            var d = weekDates[di], ds = isoDate(d);
            var th = document.createElement('th');
            var hol = null;
            for (var hi = 0; hi < holidays.length; hi++) { if (holidays[hi].date === ds) { hol = holidays[hi]; break; } }
            th.innerHTML = '<div>' + DAYS[di] + '</div><div style="font-size:10px;font-weight:400;opacity:0.8">' + formatDate(d) + '</div>' +
                           (hol ? '<div style="font-size:9px;background:rgba(255,255,255,0.2);padding:1px 3px;margin-top:2px">' + hol.name + '</div>' : '');
            if (ds === selectedDateStr) th.style.outline = '3px solid #fff';
            th.style.cursor = 'pointer';
            (function(dateStr) { th.onclick = function() { selectedDateStr = dateStr; renderTable(); }; })(ds);
            head.appendChild(th);
        }
    }

    var rangeDisp = document.getElementById('weekRangeDisplay');
    if (rangeDisp) {
        rangeDisp.innerHTML = formatDate(weekDates[0]) + ' - ' + formatDate(weekDates[6]) + '<br>' + weekDates[0].getFullYear();
    }

    var tbody = document.getElementById('tableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    var dayBooked = 0, dayBlocked = 0, dayHoliday = 0;

    for (var si = 0; si < SEATS.length; si++) {
        var seat = SEATS[si];
        var tr = document.createElement('tr');
        tr.innerHTML = '<td class="seat-label">' + seat + '</td>';

        for (var dj = 0; dj < weekDates.length; dj++) {
            var dw = weekDates[dj], ds2 = isoDate(dw);
            var td = document.createElement('td');
            td.className = 'seat-cell';
            var div = document.createElement('div');
            div.className = 'cell-inner';

            if (ds2 < todayStr) { td.style.background = '#ECBAE6'; div.style.background = '#ECBAE6'; }

            var holC = null; for (var h1 = 0; h1 < holidays.length; h1++) { if (holidays[h1].date === ds2) { holC = holidays[h1]; break; } }
            var blkC = null; for (var b1 = 0; b1 < blocked.length; b1++) { if (blocked[b1].seat === seat && blocked[b1].date === ds2) { blkC = blocked[b1]; break; } }
            var bkgC = null; for (var k1 = 0; k1 < bookings.length; k1++) { if (bookings[k1].seat === seat && bookings[k1].date === ds2) { bkgC = bookings[k1]; break; } }
            var perm = isPermanentlyBlocked(seat, ds2);

            if (holC) {
                div.className += ' holiday'; div.textContent = 'PH';
                if (ds2 === selectedDateStr) dayHoliday++;
            } else if (perm || blkC) {
                div.className += ' unavailable'; div.textContent = 'X';
                if (ds2 === selectedDateStr) dayBlocked++;
            } else if (bkgC) {
                div.className += ' booked'; div.textContent = bkgC.initials;
                (function(s, d, b) { div.onclick = function() { openManageModal(s, d, b); }; })(seat, ds2, bkgC);
                if (ds2 === selectedDateStr) dayBooked++;
            } else if (ds2 >= todayStr) {
                div.className += ' available';
                (function(s, d, l) { div.onclick = function() { openBookingModal(s, d, l); }; })(seat, ds2, DAYS[dj] + ' ' + formatDate(dw));
            }
            td.appendChild(div); tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }

    var sumDisp = document.getElementById('summaryBadges');
    if (sumDisp) {
        var dayAvail = Math.max(0, SEATS.length - dayBooked - dayBlocked - dayHoliday);
        sumDisp.innerHTML = '<span class="badge badge-booked">Booked: ' + dayBooked + '</span>' +
                            '<span class="badge badge-available">Available: ' + dayAvail + '</span>' +
                            '<span class="badge badge-unavailable">Blocked: ' + dayBlocked + '</span>';
    }
  } catch(e) { console.error('Render Error:', e); }
}

/* --- ACTIONS --- */
function openBookingModal(seat, date, dayLabel) {
  pendingCell = { seat: seat, date: date, dayLabel: dayLabel };
  document.getElementById('modalSeatInfo').textContent = seat + ' | ' + dayLabel;
  var sel = document.getElementById('empSelect');
  sel.innerHTML = '<option value="">- Select your name -</option>';
  var resList = getData(KEYS.resources);
  for (var ri = 0; ri < resList.length; ri++) {
    var opt = document.createElement('option');
    opt.value = resList[ri].initials; opt.textContent = resList[ri].name + ' (' + resList[ri].initials + ')';
    sel.appendChild(opt);
  }
  document.getElementById('empSelectErr').classList.remove('show');
  openModal('bookingModal');
}

function confirmBooking() {
  var initials = document.getElementById('empSelect').value;
  if (!initials) { document.getElementById('empSelectErr').classList.add('show'); return; }

  var b = getData(KEYS.bookings);
  for (var bi = 0; bi < b.length; bi++) {
    if (b[bi].initials === initials && b[bi].date === pendingCell.date) {
      if (!confirm(initials + ' already has a seat booked on this day. Book another?')) return;
      break;
    }
  }

  /* Optimistically update local cache so UI feels instant */
  b.push({ seat: pendingCell.seat, date: pendingCell.date, initials: initials });
  setData(KEYS.bookings, b);
  closeModal('bookingModal');
  renderTable();
  showToast('Booking seat...', 'success');

  /* Write to Supabase — realtime will then sync all other users */
  if (_sb) {
    _sb.from('bookings').insert([{ seat: pendingCell.seat, date: pendingCell.date, initials: initials }]).then(function(res) {
      if (res.error) {
        showToast('Sync error. Please refresh.', 'error');
        /* Roll back local cache on error */
        syncAllFromSupabase();
      } else {
        showToast('Seat booked!', 'success');
      }
    });
  }
}

function openManageModal(seat, date, bkg) {
  manageCell = { seat: seat, date: date, booking: bkg };
  document.getElementById('manageSeatInfo').textContent = seat + ' | Booked by ' + bkg.initials;
  document.getElementById('editInitials').value = bkg.initials;
  document.getElementById('ownerVerifyInput').value = '';
  openModal('manageModal');
}

function cancelBooking() {
  var admin = getDataRaw(KEYS.adminLoggedIn) === '1';
  var verify = document.getElementById('ownerVerifyInput').value.trim().toUpperCase();
  if (!admin && verify !== manageCell.booking.initials) { showToast('Verify initials to cancel', 'error'); return; }
  if (!confirm('Cancel this booking?')) return;

  var s = manageCell.seat, d = manageCell.date;
  closeModal('manageModal');

  /* Optimistic local update */
  var b = getData(KEYS.bookings).filter(function(x) { return !(x.seat === s && x.date === d); });
  setData(KEYS.bookings, b); renderTable();

  if (_sb) {
    _sb.from('bookings').delete().eq('seat', s).eq('date', d).then(function(res) {
      if (res.error) {
        showToast('Sync error. Please refresh.', 'error');
        syncAllFromSupabase();
      } else {
        showToast('Booking cancelled.', 'info');
      }
    });
  }
}

function saveEditBooking() {
  var ini = document.getElementById('editInitials').value.trim().toUpperCase();
  if (!ini) return;
  var b = getData(KEYS.bookings);
  for (var i = 0; i < b.length; i++) {
    if (b[i].seat === manageCell.seat && b[i].date === manageCell.date) { b[i].initials = ini; break; }
  }
  setData(KEYS.bookings, b); closeModal('manageModal'); renderTable();
  if (_sb) _sb.from('bookings').update({ initials: ini }).eq('seat', manageCell.seat).eq('date', manageCell.date).then();
}

/* --- ADMIN --- */
function renderAdminBookings() {
  var b = getData(KEYS.bookings);
  var tb = document.getElementById('adminBookingsBody');
  if (!tb) return;
  tb.innerHTML = b.length ? b.map(function(x) { return '<tr><td>'+x.seat+'</td><td>'+x.date+'</td><td>'+x.initials+'</td><td><button class="btn-sm del" onclick="adminDeleteBooking(\''+x.seat+'\',\''+x.date+'\')">Del</button></td></tr>'; }).join('') : '<tr><td colspan="4">No bookings</td></tr>';
}

function adminDeleteBooking(s, d) {
  if (!confirm('Delete this booking?')) return;
  if (_sb) {
    _sb.from('bookings').delete().eq('seat', s).eq('date', d).then(function() { syncAllFromSupabase(); });
  }
}

function renderAdminResources() {
  var r = getData(KEYS.resources);
  var tb = document.getElementById('adminResourceBody');
  if (!tb) return;
  tb.innerHTML = r.map(function(x, i) { return '<tr><td>'+x.name+'</td><td>'+x.initials+'</td><td>Office</td><td><button class="btn-sm del" onclick="adminDeleteResource('+i+')">Del</button></td></tr>'; }).join('');
}

function adminAddResource() {
  var n = document.getElementById('resNameInput').value.trim(), i = document.getElementById('resInitialsInput').value.trim().toUpperCase();
  if (!n || !i) return;
  var r = getData(KEYS.resources);
  r.push({ name: n, initials: i, type: 'Office Seating', status: 'Available' });
  setData(KEYS.resources, r); renderAdminResources();
  document.getElementById('resNameInput').value = ''; document.getElementById('resInitialsInput').value = '';
  if (_sb) _sb.from('resources').insert([{ name: n, initials: i, type: 'Office Seating', status: 'Available' }]).then();
}

function adminDeleteResource(idx) {
  var r = getData(KEYS.resources);
  var target = r.splice(idx, 1)[0];
  setData(KEYS.resources, r); renderAdminResources();
  if (_sb && target) _sb.from('resources').delete().eq('initials', target.initials).then();
}

function renderAdminHolidays() {
  var h = getData(KEYS.holidays);
  var el = document.getElementById('holidayList');
  if (!el) return;
  el.innerHTML = h.map(function(x) { return '<div>'+x.date+' - '+x.name+' <button class="btn-sm del" onclick="adminRemoveHoliday(\''+x.date+'\')">X</button></div>'; }).join('');
}

function adminAddHoliday() {
  var d = document.getElementById('holidayDateInput').value, n = document.getElementById('holidayNameInput').value.trim();
  if (!d || !n) return;
  var h = getData(KEYS.holidays); h.push({ date: d, name: n });
  setData(KEYS.holidays, h); renderAdminHolidays(); renderTable();
  if (_sb) _sb.from('holidays').insert([{ date: d, name: n }]).then();
}

function adminRemoveHoliday(d) {
  var h = getData(KEYS.holidays).filter(function(x) { return x.date !== d; });
  setData(KEYS.holidays, h); renderAdminHolidays(); renderTable();
  if (_sb) _sb.from('holidays').delete().eq('date', d).then();
}

function adminBlockSeat() {
  var s = document.getElementById('blockSeatInput').value.toUpperCase(), d = document.getElementById('blockDateInput').value;
  if (!s || !d) return;
  var b = getData(KEYS.blocked); b.push({ seat: s, date: d });
  setData(KEYS.blocked, b); renderTable();
  if (_sb) _sb.from('blocked').insert([{ seat: s, date: d }]).then();
}

function adminUnblockSeat() {
  var s = document.getElementById('blockSeatInput').value.toUpperCase(), d = document.getElementById('blockDateInput').value;
  var b = getData(KEYS.blocked).filter(function(x) { return !(x.seat === s && x.date === d); });
  setData(KEYS.blocked, b); renderTable();
  if (_sb) _sb.from('blocked').delete().eq('seat', s).eq('date', d).then();
}

function confirmResetAll() {
  if (!confirm('Clear ALL bookings? This cannot be undone.')) return;
  setData(KEYS.bookings, []); renderTable();
  if (_sb) _sb.from('bookings').delete().neq('seat', '').then(function() { syncAllFromSupabase(); });
}

/* Export helpers */
function exportBookings() {
  var b = getData(KEYS.bookings);
  var blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bookings.json'; a.click();
}
function exportBookingsCSV() {
  var b = getData(KEYS.bookings);
  var csv = 'Seat,Date,Initials\n' + b.map(function(x) { return x.seat+','+x.date+','+x.initials; }).join('\n');
  var blob = new Blob([csv], { type: 'text/csv' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bookings.csv'; a.click();
}

/* --- UTILS --- */
function openModal(id) { var el=document.getElementById(id); if(el) el.classList.add('open'); }
function closeModal(id) { var el=document.getElementById(id); if(el) el.classList.remove('open'); }
function showToast(m, s) { var t = document.getElementById('toast'); if(!t) return; t.textContent = m; t.className = 'toast show ' + (s||''); setTimeout(function() { t.classList.remove('show'); }, 3000); }
function changeWeek(d) { currentWeekStart = addDays(currentWeekStart, d * 7); renderTable(); }
function closeImageZoom(e) { if (e.target === document.getElementById('imgZoomModal')) closeModal('imgZoomModal'); }

function showPage(p) {
  document.getElementById('bookingPage').classList.toggle('hidden', p !== 'booking');
  document.getElementById('adminPage').classList.toggle('active', p === 'admin');
  document.getElementById('resourcesPage').classList.toggle('active', p === 'resources');
  if (p === 'resources') renderResources();
  if (p === 'admin') { renderAdminBookings(); renderAdminResources(); renderAdminHolidays(); }
}

function requestAdmin() { if (getDataRaw(KEYS.adminLoggedIn) === '1') { showPage('admin'); } else { openModal('adminLoginOverlay'); } }
function checkAdminPass() {
  if (document.getElementById('adminPassInput').value === 'admin123') {
    setDataRaw(KEYS.adminLoggedIn, '1'); closeModal('adminLoginOverlay'); showPage('admin');
  } else {
    var err = document.getElementById('adminPassErr'); if(err) err.style.display = 'block';
  }
}
function checkUserPass() {
  if (document.getElementById('userPassInput').value === 'focal123') {
    sessionStorage.setItem('focal_user_authed', '1');
    var overlay = document.getElementById('userLoginOverlay');
    if (overlay) overlay.style.display = 'none';
    appInit();
  }
}

function handleLayoutUpload(e) {
  var f = e.target.files[0]; if (!f) return;
  var r = new FileReader();
  r.onload = function(ev) { setDataRaw(KEYS.layoutImg, ev.target.result); showLayoutImage(ev.target.result); };
  r.readAsDataURL(f);
}
function showLayoutImage(s) {
  var i = document.getElementById('layoutImg'), p = document.getElementById('layoutPlaceholder');
  if(i) { i.src = s; i.className = 'loaded'; i.style.display='block'; if(p) p.style.display = 'none'; }
}
function loadSavedLayout() { var s = getDataRaw(KEYS.layoutImg); if(s) showLayoutImage(s); }
function openImageZoom() { var i = document.getElementById('layoutImg'); if(i && i.src) { document.getElementById('imgZoomTarget').src = i.src; openModal('imgZoomModal'); } }

/* --- SEED EMPLOYEE DATA (runs once, only seeds localStorage, then pushes to Supabase) --- */
function seedEmployeesIfNeeded() {
  if (getDataRaw('_focal_seeded_v5')) return;
  var res = [
    { name:'Vinod Kumar',           initials:'VK',  type:'Office Seating', status:'Available' },
    { name:'Mohammed Basheer',      initials:'MB',  type:'Office Seating', status:'Available' },
    { name:'Nidhina Jamal',         initials:'NJ',  type:'Office Seating', status:'Available' },
    { name:'Anish Kumar',           initials:'AK',  type:'Office Seating', status:'Available' },
    { name:'Bhagyaraj NG',          initials:'BN',  type:'Office Seating', status:'Available' },
    { name:'Akshay S',              initials:'AS',  type:'Office Seating', status:'Available' },
    { name:'Aneesh M A',            initials:'AM',  type:'Office Seating', status:'Available' },
    { name:'Aswin Chandh C S',      initials:'AC',  type:'Office Seating', status:'Available' },
    { name:'Muralidharan K',        initials:'MK',  type:'Office Seating', status:'Available' },
    { name:'Sameer Venugopal',      initials:'SV',  type:'Office Seating', status:'Available' },
    { name:'Arun Das',              initials:'AD',  type:'Office Seating', status:'Available' },
    { name:'Sidharth S Nair',       initials:'SN',  type:'Office Seating', status:'Available' },
    { name:'Ajith P Babu',          initials:'AB',  type:'Office Seating', status:'Available' },
    { name:'Arun P J',              initials:'AP',  type:'Office Seating', status:'Available' },
    { name:'Abhijith N',            initials:'ABN', type:'Office Seating', status:'Available' },
    { name:'Ponnu Anna Varghese',   initials:'PA',  type:'Office Seating', status:'Available' },
    { name:'Jinto Thomas',          initials:'JT',  type:'Office Seating', status:'Available' },
    { name:'Anusuya N V',           initials:'ANV', type:'Office Seating', status:'Available' },
    { name:'Mohammed Abu Thahair',  initials:'MA',  type:'Office Seating', status:'Available' },
    { name:'Magesh M',              initials:'MM',  type:'Office Seating', status:'Available' },
    { name:'Gouri Vinod',           initials:'GV',  type:'Office Seating', status:'Available' },
    { name:'Sooraj R',              initials:'SR',  type:'Office Seating', status:'Available' },
    { name:'Kaverimani Ramasamy',   initials:'KR',  type:'Office Seating', status:'Available' },
    { name:'Aby George',            initials:'AG',  type:'Office Seating', status:'Available' },
    { name:'Jayakrishnan O J',      initials:'JO',  type:'Office Seating', status:'Available' },
    { name:'Jeevan Roy',            initials:'JR',  type:'Office Seating', status:'Available' },
    { name:'Ajmal Khan',            initials:'AJK', type:'Office Seating', status:'Available' },
    { name:'Vijesh Vijayan',        initials:'VV',  type:'Office Seating', status:'Available' },
    { name:'ShihabM',               initials:'SH',  type:'Office Seating', status:'Available' },
    { name:'Akhil Menon',           initials:'AKM', type:'Office Seating', status:'Available' },
    { name:'Samjid Basheer',        initials:'SB',  type:'Office Seating', status:'Available' },
    { name:'Sharafath Mon',         initials:'SM',  type:'Office Seating', status:'Available' }
  ];
  setData(KEYS.resources, res);
  setDataRaw('_focal_seeded_v5', '1');

  /* Push employees to Supabase so they sync across all browsers */
  if (_sb) {
    _sb.from('resources').select('id').limit(1).then(function(check) {
      if (!check.error && check.data && check.data.length === 0) {
        _sb.from('resources').insert(res).then();
      }
    });
  }
}

function renderResources() {
  var r = getData(KEYS.resources);
  var tb = document.getElementById('resourcesTableBody');
  if(!tb) return;
  tb.innerHTML = r.map(function(x, i) { return '<tr><td>'+(i+1)+'</td><td><strong>'+x.name+'</strong></td><td>'+x.initials+'</td><td>Office</td><td>Available</td></tr>'; }).join('');
}

/* --- INIT ---
   FIX: renderTable() is NOT called before Supabase loads.
   We show a loading indicator, then call syncAllFromSupabase()
   which calls renderTable() only after data is fetched.
*/
var _appReady = false;

function appInit() {
  var loginOverlay = document.getElementById('userLoginOverlay');
  if (sessionStorage.getItem('focal_user_authed') !== '1') {
    if (loginOverlay) { loginOverlay.style.display = 'flex'; loginOverlay.classList.add('open'); }
    return;
  }

  currentWeekStart = getMonday(new Date());
  loadSavedLayout();

  var notice = document.getElementById('spScriptBlockedNotice');
  if (notice) notice.style.display = 'none';

  if (initSupabase()) {
    _appReady = true;
    seedEmployeesIfNeeded();          /* seed employees into Supabase if first run */
    syncAllFromSupabase();            /* fetch bookings+blocked+holidays → then renderTable */
    syncResourcesFromSupabase();      /* fetch employees */
    sbSubscribeAll();                 /* live updates for all users */
  } else {
    /* Supabase not available — fall back to cached local data */
    seedEmployeesIfNeeded();
    renderTable();
    renderResources();
  }
}

/* Retry init a few times to handle slow Supabase CDN load */
function scheduleInitRetries() {
  var delays = [100, 600, 1500, 3000];
  for (var i = 0; i < delays.length; i++) {
    (function(ms) {
      setTimeout(function() { if (!_appReady) appInit(); }, ms);
    })(delays[i]);
  }
}

document.addEventListener('DOMContentLoaded', function() { appInit(); scheduleInitRetries(); });
if (document.readyState === 'interactive' || document.readyState === 'complete') { appInit(); scheduleInitRetries(); }
