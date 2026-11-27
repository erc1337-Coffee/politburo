set -x
id
echo "HOME=$HOME"
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.4.0 || true
command -v pi && pi --version || true
pi install npm:@pi-plugins/claude-cli@0.3.0 || true
exit 0
