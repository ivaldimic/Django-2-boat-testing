// Default boats shown on a fresh device (before anyone edits Settings).
// During development these point at the local simulator. On the nav PC, set them
// in Settings to each boat's bridge, e.g. ws://192.168.1.101:8080
window.DEFAULT_BOATS = [
  { id: "boat1", name: "Boat 1", url: "ws://localhost:8090" },
  { id: "boat2", name: "Boat 2", url: "ws://localhost:8091" }
];
