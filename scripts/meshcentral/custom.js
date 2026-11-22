// Petra Remote (MeshCentral) page add-on.
// Deployed to C:\Petra\meshcentral\meshcentral-web\public\scripts\custom.js on
// PETRA-APP; MeshCentral loads scripts/custom.js in the <head> of every page and
// serves it from meshcentral-web\public when that folder exists (checked at
// MeshCentral start, so a restart is needed the first time).
//
// The IT Network page links here with
//   ?viewmode=11&gotonode=<hex id>&petra=view     -> view only, auto-connect
//   ?viewmode=11&gotonode=<hex id>&petra=control  -> full control, auto-connect
//   ?viewmode=11&gotonode=<hex id>&petra=consent  -> ask the user first
// "view" turns MeshCentral's Desktop "Input" checkbox off (mouse/keyboard not
// sent), "control" turns it on, then the desktop connects once the device page
// is showing. "consent" connects like MeshCentral's own "Ask Consent + Bar":
// the logged-on user gets an Allow/Deny prompt (0x0008) and, once allowed, a
// bar on their screen showing the session with a Disconnect button (0x0040).
//
// On every page it also adds an "Ask user" button next to the Desktop tab's
// Connect button, doing the same consent connect (MeshCentral only offers it
// in Connect's right-click menu). It mirrors Connect: disabled while the
// device is offline, hidden while a session is open.

// --- "Ask user" button beside Connect (Desktop tab)
;(function () {
  var CONSENT = 0x0008 + 0x0040 // Allow/Deny prompt + session bar
  function ensureButton() {
    var connect = document.getElementById('connectbutton1')
    var connectSpan = document.getElementById('connectbutton1span')
    if (!connect || !connectSpan) return
    var span = document.getElementById('petraAskUserSpan')
    if (!span) {
      span = document.createElement('span')
      span.id = 'petraAskUserSpan'
      var btn = document.createElement('input')
      btn.type = 'button'
      btn.id = 'petraAskUserButton'
      btn.value = 'Ask user'
      btn.title =
        'Connect only after the logged-on user clicks Allow; they see a bar with a Disconnect button'
      btn.style.marginLeft = '4px'
      btn.onkeypress = btn.onkeydown = function () {
        return false
      }
      btn.onclick = function () {
        try {
          var box = document.getElementById('DeskControl')
          if (box && !box.checked) {
            box.checked = true
            if (typeof toggleKvmControl === 'function') toggleKvmControl()
          }
          connectDesktop(null, 3, null, CONSENT)
        } catch (e) {}
      }
      span.appendChild(btn)
      connectSpan.parentNode.insertBefore(span, connectSpan.nextSibling)
    }
    var b = document.getElementById('petraAskUserButton')
    b.disabled = connect.disabled
    span.style.display = connectSpan.style.display
  }
  setInterval(function () {
    try {
      ensureButton()
    } catch (e) {}
  }, 500)
})()

// --- links from the IT Network page (?petra=view|control|consent)
;(function () {
  var m = /[?&]petra=(view|control|consent)(?:&|$)/.exec(window.location.search)
  if (!m) return
  var viewOnly = m[1] === 'view'
  var askUser = m[1] === 'consent'

  // MeshCentral reads this localStorage key when the page starts and again
  // when the desktop connects; we run in <head>, before either.
  try {
    localStorage.setItem('DeskControl', viewOnly ? '0' : '1')
  } catch (e) {}

  var tries = 0
  var timer = setInterval(function () {
    tries++
    if (tries > 120) return clearInterval(timer) // give up after ~60 s
    try {
      if (typeof xxcurrentView === 'undefined' || xxcurrentView !== 11) return
      if (typeof connectDesktop !== 'function' || !currentNode) return
      if (typeof xxdialogMode !== 'undefined' && xxdialogMode) return
      clearInterval(timer)
      if (typeof desktop !== 'undefined' && desktop) return // already connected
      if ((currentNode.conn & 1) === 0) return // agent offline
      var box = document.getElementById('DeskControl')
      if (box) {
        box.checked = !viewOnly
        if (typeof toggleKvmControl === 'function') toggleKvmControl()
      }
      // contype 3 = pick the logged-on user's session (prompt shows there);
      // with no user session MeshCentral connects to the console with the
      // same consent flags, and the agent may refuse (nobody to ask).
      if (askUser) connectDesktop(null, 3, null, 0x0008 + 0x0040)
      else connectDesktop(null, 1)
    } catch (e) {
      clearInterval(timer)
    }
  }, 500)
})()
