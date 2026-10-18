"""Fixed cloud PDF operations with process resource limits; no shell or user options."""
import os
import resource
import sys


def main():
    if len(sys.argv) not in (3, 4):
        raise ValueError("Unsupported PDF operation")
    mode, source = sys.argv[1:3]
    if not os.path.isabs(source):
        raise ValueError("Absolute PDF path required")
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (20, 21))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    if mode == "text" and len(sys.argv) == 3:
        command = ["/usr/bin/pdftotext", "-enc", "UTF-8", "-layout", source, "-"]
    elif mode == "info" and len(sys.argv) == 3:
        command = ["/usr/bin/pdfinfo", "-enc", "UTF-8", source]
    elif mode == "render" and len(sys.argv) == 4 and sys.argv[3] in ("1", "2", "3"):
        command = ["/usr/bin/pdftoppm", "-f", sys.argv[3], "-l", sys.argv[3], "-singlefile", "-png", "-scale-to", "1280", source]
    else:
        raise ValueError("Unsupported PDF operation")
    os.execv(command[0], command)


if __name__ == "__main__":
    main()
