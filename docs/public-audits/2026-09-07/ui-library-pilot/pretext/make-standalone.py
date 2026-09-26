from pathlib import Path
import base64
root=Path(__file__).parent
html=(root/'index.html').read_text().replace('./geist.woff2','data:font/woff2;base64,'+base64.b64encode((root/'geist.woff2').read_bytes()).decode())
js=(root/'bundle.js').read_text().replace('</script','<\\/script')
html=html.replace('<script type="module" src="./bundle.js"></script>','<script type="module">'+js+'</script>')
(root/'standalone.html').write_text(html)
