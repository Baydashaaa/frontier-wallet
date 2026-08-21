// Loading order matches the order these blocks had in index.html.
// Several of them attach handlers as they run, so the sequence is not
// cosmetic.
import './shell.js';
import './onboarding.js';
import './crypto.js';
import './chain.js';
import './market.js';
import './tokens.js';
import './storage.js';
import './boot.js';
