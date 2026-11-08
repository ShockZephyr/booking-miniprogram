// Backups pin immutable image files against deletion. Ordinary catalog and booking
// transactions never acquire this lock. Cleanup takes it before the identity lock.
module.exports = 582303;
