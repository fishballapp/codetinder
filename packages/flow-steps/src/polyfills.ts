// The code is written to the ES2025 lib; the flow's default image runs Node 20, which has ES2023.
// These bring the ES2024 and ES2025 built-ins (tsdown already lowers the syntax). Keep the list in
// step with the `lib` in this package's and core's tsconfig. Not polyfillable, so don't use them:
// `Float16Array`, `Intl.DurationFormat`, `Atomics.waitAsync`.

// ES2024
import 'core-js/es/array-buffer';
import 'core-js/es/map/group-by';
import 'core-js/es/object/group-by';
import 'core-js/es/promise/with-resolvers';
import 'core-js/es/string/is-well-formed';
import 'core-js/es/string/to-well-formed';
// ES2025
import 'core-js/es/iterator';
import 'core-js/es/math/f16round';
import 'core-js/es/promise/try';
import 'core-js/es/regexp/escape';
import 'core-js/es/set';
