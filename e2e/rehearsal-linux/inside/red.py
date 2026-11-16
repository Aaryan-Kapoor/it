# A 96x96 picture, red with a white cross, as a PNG, for a page that takes a photo
import struct, sys, zlib
w = h = 96
rows = []
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        row += b'\xff\xff\xff' if abs(x - 48) < 6 or abs(y - 48) < 6 else b'\xd0\x10\x10'
    rows.append(bytes(row))
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))
