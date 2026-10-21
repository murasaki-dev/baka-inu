"""One bounded SMB range read. Secrets arrive on stdin, never argv or logs."""
import errno
import json
import os
import re
import stat
import sys


def header(value):
    sys.stdout.buffer.write((json.dumps(value) + '\n').encode())
    sys.stdout.buffer.flush()


def main():
    sent = False
    media = None
    try:
        import smbc
        request = json.loads(sys.stdin.buffer.read(16385))
        credentials = request.get('credentials') or {}
        domain = credentials.get('domain', '')
        username = credentials.get('username', '')
        password = credentials.get('password', '')
        context = smbc.Context(auth_fn=lambda *_: (domain, username, password))
        context.timeout = 10000
        if username:
            context.optionNoAutoAnonymousLogin = True
        media = context.open(request['url'], os.O_RDONLY)
        info = media.fstat()
        if not stat.S_ISREG(info[0]):
            raise OSError(errno.EINVAL, 'Not a regular file')
        size = info[6]
        start, end, status = 0, size - 1, 200
        requested_range = request.get('range', '')
        if requested_range:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested_range)
            if not match or not any(match.groups()):
                header({'status': 416, 'size': size})
                return
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            else:
                start = max(0, size - int(last))
            if start > end or start >= size:
                header({'status': 416, 'size': size})
                return
            status = 206
        length = max(0, end - start + 1)
        media.seek(start, os.SEEK_SET)
        header({'status': status, 'size': size, 'start': start, 'end': end, 'length': length})
        sent = True
        if request.get('head'):
            return
        remaining = length
        while remaining:
            chunk = media.read(min(256 * 1024, remaining))
            if not chunk:
                raise OSError(errno.EIO, 'Unexpected EOF')
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            remaining -= len(chunk)
    except BrokenPipeError:
        pass  # mpv closes old HTTP requests when seeking.
    except Exception as error:
        if not sent:
            number = getattr(error, 'errno', None)
            reason = ('SMB sign-in or file access was denied' if number in (errno.EACCES, errno.EPERM)
                      else 'SMB file was not found' if number == errno.ENOENT
                      else 'SMB relay dependency is missing; rebuild the image' if isinstance(error, ImportError)
                      else 'SMB file could not be read; check the share and connection')
            header({'status': 502, 'error': reason})
        sys.exit(1)
    finally:
        if media:
            media.close()


if __name__ == '__main__':
    main()
