⏺ All set. Now you need to do browser auth — this opens a browser window where you log into DoorDash. Run
  this:                                              

  ! cd /Users/bowei/code/test/003/latchkey && LATCHKEY_CURL=/Users/bowei/code/test/003/curl_chrome136 npx
  latchkey auth browser doordash

  This will open a browser. Log into your DoorDash account. Latchkey captures session cookies and stores
  them encrypted in ~/.latchkey.

  After that completes, I'll validate the auth works.

