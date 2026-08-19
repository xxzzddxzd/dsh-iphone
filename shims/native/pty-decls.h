#pragma once
#include <sys/ioctl.h>
#include <sys/types.h>
#include <termios.h>

extern "C" int openpty(int *, int *, char *, const struct termios *, const struct winsize *);
