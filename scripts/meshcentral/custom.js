// Petra Remote (MeshCentral) page add-on.
// Deployed to C:\Petra\meshcentral\meshcentral-web\public\scripts\custom.js on
// PETRA-APP; MeshCentral loads scripts/custom.js in the <head> of every page and
// serves it from meshcentral-web\public when that folder exists (checked at
// MeshCentral start, so a restart is needed the first time).
//
// The IT Network page links here with
//   ?viewmode=11&gotonode=<hex id>&petra=view     -> view only, auto-connect
//   ?viewmode=11&gotonode=<hex id>&petra=control  -> full control, auto-connect
// "view" turns MeshCentral's Desktop "Input" checkbox off (mouse/keyboard not
// sent), "control" turns it on, then the desktop connects once the device page
// is showing. Without ?petra= this script does nothing.
(function () {
  var m = /[?&]petra=(view|control)(?:&|$)/.exec(window.location.search)
  if (!m) return
  var viewOnly = m[1] === 'view'

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
      connectDesktop(null, 1)
    } catch (e) {
      clearInterval(timer)
    }
  }, 500)
})()
