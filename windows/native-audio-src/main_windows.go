// swt-audio: records the speaker output (WASAPI loopback) and, optionally, a microphone
// straight from Windows, into WAV files. Controlled over stdin by SWT Capture.
//
// Usage:  swt-audio.exe [-sys out_sys.wav] [-mic out_mic.wav] [-micname "Name"]
// stdin:  go | pause | resume | mute | unmute | stop
// stdout: READY <kind> <rate> <channels> <bits> <float> | NOMIC | LEVEL <sys> <mic> | DONE | ERROR <msg>
package main

import (
	"bufio"
	"encoding/binary"
	"flag"
	"fmt"
	"math"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// ---------------------------------------------------------------- COM plumbing
type GUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	CLSID_MMDeviceEnumerator = GUID{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	IID_IMMDeviceEnumerator  = GUID{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	IID_IAudioClient         = GUID{0x1CB9AD4C, 0xDBFA, 0x4C32, [8]byte{0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}}
	IID_IAudioCaptureClient  = GUID{0xC8ADBD64, 0xE71E, 0x48A0, [8]byte{0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}}
	SUBTYPE_IEEE_FLOAT       = GUID{0x00000003, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}}
	PKEY_FriendlyName_fmtid  = GUID{0xA45C254E, 0xDF1C, 0x4EFD, [8]byte{0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}
)

const (
	CLSCTX_ALL                 = 0x17
	COINIT_MULTITHREADED       = 0x0
	eRender                    = 0
	eCapture                   = 1
	eConsole                   = 0
	DEVICE_STATE_ACTIVE        = 1
	AUDCLNT_SHAREMODE_SHARED   = 0
	AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
	AUDCLNT_BUFFERFLAGS_SILENT = 0x2
	STGM_READ                  = 0
	VT_LPWSTR                  = 31
	WAVE_FORMAT_PCM            = 1
	WAVE_FORMAT_IEEE_FLOAT     = 3
	WAVE_FORMAT_EXTENSIBLE     = 0xFFFE
)

var (
	ole32                = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree    = ole32.NewProc("CoTaskMemFree")
	procPropVariantClear = ole32.NewProc("PropVariantClear")
)

// call invokes method #idx of a COM object's vtable.
func call(obj uintptr, idx int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

func release(obj uintptr) {
	if obj != 0 {
		call(obj, 2)
	}
}

func hr(name string, r uintptr) error {
	if int32(r) < 0 {
		return fmt.Errorf("%s failed: 0x%08X", name, uint32(r))
	}
	return nil
}

// ---------------------------------------------------------------- WAVEFORMATEX
type waveFormatEx struct {
	FormatTag      uint16
	Channels       uint16
	SamplesPerSec  uint32
	AvgBytesPerSec uint32
	BlockAlign     uint16
	BitsPerSample  uint16
	CbSize         uint16
}

type format struct {
	rate, channels, bits int
	isFloat              bool
	blockAlign           int
}

func readFormat(p uintptr) format {
	wf := (*waveFormatEx)(unsafe.Pointer(p))
	f := format{rate: int(wf.SamplesPerSec), channels: int(wf.Channels), bits: int(wf.BitsPerSample), blockAlign: int(wf.BlockAlign)}
	switch wf.FormatTag {
	case WAVE_FORMAT_IEEE_FLOAT:
		f.isFloat = true
	case WAVE_FORMAT_EXTENSIBLE:
		if wf.CbSize >= 22 {
			sub := (*GUID)(unsafe.Pointer(p + 24))
			f.isFloat = *sub == SUBTYPE_IEEE_FLOAT
		}
	}
	return f
}

// ---------------------------------------------------------------- WAV writer
type wavWriter struct {
	f       *os.File
	w       *bufio.Writer
	fmt     format
	written int64 // bytes of audio data
}

func newWav(path string, f format) (*wavWriter, error) {
	fh, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	ww := &wavWriter{f: fh, w: bufio.NewWriterSize(fh, 1<<20), fmt: f}
	ww.header(0)
	return ww, nil
}

func (ww *wavWriter) header(dataLen uint32) {
	tag := uint16(WAVE_FORMAT_PCM)
	if ww.fmt.isFloat {
		tag = WAVE_FORMAT_IEEE_FLOAT
	}
	b := make([]byte, 44)
	copy(b[0:], "RIFF")
	binary.LittleEndian.PutUint32(b[4:], 36+dataLen)
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], tag)
	binary.LittleEndian.PutUint16(b[22:], uint16(ww.fmt.channels))
	binary.LittleEndian.PutUint32(b[24:], uint32(ww.fmt.rate))
	binary.LittleEndian.PutUint32(b[28:], uint32(ww.fmt.rate*ww.fmt.blockAlign))
	binary.LittleEndian.PutUint16(b[32:], uint16(ww.fmt.blockAlign))
	binary.LittleEndian.PutUint16(b[34:], uint16(ww.fmt.bits))
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], dataLen)
	ww.w.Write(b)
}

func (ww *wavWriter) write(p []byte) { ww.w.Write(p); ww.written += int64(len(p)) }

func (ww *wavWriter) silence(frames int64) {
	if frames <= 0 {
		return
	}
	zero := make([]byte, 4096)
	n := frames * int64(ww.fmt.blockAlign)
	for n > 0 {
		k := int64(len(zero))
		if n < k {
			k = n
		}
		ww.write(zero[:k])
		n -= k
	}
}

func (ww *wavWriter) close() {
	ww.w.Flush()
	ww.f.Seek(0, 0)
	n := ww.written
	if n > 0xFFFFFFF0 {
		n = 0xFFFFFFF0
	}
	hdr := bufio.NewWriter(ww.f)
	old := ww.w
	ww.w = hdr
	ww.header(uint32(n))
	hdr.Flush()
	ww.w = old
	ww.f.Close()
}

// ---------------------------------------------------------------- one capture stream
type stream struct {
	kind     string
	client   uintptr
	capture  uintptr
	fmt      format
	out      *wavWriter
	frames   int64     // frames written since "go"
	lastData time.Time // last time real audio arrived
	peak     float64
	muted    bool
}

func openStream(enum uintptr, kind string, micName string, path string) (*stream, error) {
	var dev uintptr
	if kind == "sys" {
		if err := hr("GetDefaultAudioEndpoint", call(enum, 4, eRender, eConsole, uintptr(unsafe.Pointer(&dev)))); err != nil {
			return nil, err
		}
	} else {
		dev = findMic(enum, micName)
		if dev == 0 {
			if err := hr("GetDefaultAudioEndpoint(mic)", call(enum, 4, eCapture, eConsole, uintptr(unsafe.Pointer(&dev)))); err != nil {
				return nil, err
			}
		}
	}
	defer release(dev)

	var client uintptr
	if err := hr("Activate", call(dev, 3, uintptr(unsafe.Pointer(&IID_IAudioClient)), CLSCTX_ALL, 0, uintptr(unsafe.Pointer(&client)))); err != nil {
		return nil, err
	}
	var wfx uintptr
	if err := hr("GetMixFormat", call(client, 8, uintptr(unsafe.Pointer(&wfx)))); err != nil {
		release(client)
		return nil, err
	}
	f := readFormat(wfx)
	flags := uintptr(0)
	if kind == "sys" {
		flags = AUDCLNT_STREAMFLAGS_LOOPBACK
	}
	// 200 ms buffer (REFERENCE_TIME is in 100 ns units)
	err := hr("Initialize", call(client, 3, AUDCLNT_SHAREMODE_SHARED, flags, 2000000, 0, wfx, 0))
	procCoTaskMemFree.Call(wfx)
	if err != nil {
		release(client)
		return nil, err
	}
	var capture uintptr
	if err := hr("GetService", call(client, 14, uintptr(unsafe.Pointer(&IID_IAudioCaptureClient)), uintptr(unsafe.Pointer(&capture)))); err != nil {
		release(client)
		return nil, err
	}
	out, err := newWav(path, f)
	if err != nil {
		release(capture)
		release(client)
		return nil, err
	}
	if err := hr("Start", call(client, 10)); err != nil {
		return nil, err
	}
	return &stream{kind: kind, client: client, capture: capture, fmt: f, out: out}, nil
}

// findMic returns the active capture device whose friendly name matches (case-insensitive, either contains the other).
func findMic(enum uintptr, name string) uintptr {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" || name == "default" {
		return 0
	}
	var coll uintptr
	if int32(call(enum, 3, eCapture, DEVICE_STATE_ACTIVE, uintptr(unsafe.Pointer(&coll)))) < 0 {
		return 0
	}
	defer release(coll)
	var count uint32
	call(coll, 3, uintptr(unsafe.Pointer(&count)))
	for i := uint32(0); i < count; i++ {
		var dev uintptr
		if int32(call(coll, 4, uintptr(i), uintptr(unsafe.Pointer(&dev)))) < 0 {
			continue
		}
		fn := strings.ToLower(friendlyName(dev))
		if fn != "" && (strings.Contains(name, fn) || strings.Contains(fn, name)) {
			return dev
		}
		release(dev)
	}
	return 0
}

func friendlyName(dev uintptr) string {
	var store uintptr
	if int32(call(dev, 4, STGM_READ, uintptr(unsafe.Pointer(&store)))) < 0 {
		return ""
	}
	defer release(store)
	key := struct {
		fmtid GUID
		pid   uint32
	}{PKEY_FriendlyName_fmtid, 14}
	var pv [24]byte // PROPVARIANT
	if int32(call(store, 5, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv[0])))) < 0 {
		return ""
	}
	defer procPropVariantClear.Call(uintptr(unsafe.Pointer(&pv[0])))
	if binary.LittleEndian.Uint16(pv[0:]) != VT_LPWSTR {
		return ""
	}
	p := *(*uintptr)(unsafe.Pointer(&pv[8]))
	if p == 0 {
		return ""
	}
	var u []uint16
	for i := uintptr(0); i < 512; i++ {
		c := *(*uint16)(unsafe.Pointer(p + i*2))
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return syscall.UTF16ToString(u)
}

// drain reads every waiting packet. When active it writes them, otherwise it discards them.
func (s *stream) drain(active bool) {
	for {
		var packet uint32
		if int32(call(s.capture, 5, uintptr(unsafe.Pointer(&packet)))) < 0 || packet == 0 {
			return
		}
		var data uintptr
		var frames, flags uint32
		if int32(call(s.capture, 3, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&frames)), uintptr(unsafe.Pointer(&flags)), 0, 0)) < 0 {
			return
		}
		n := int(frames) * s.fmt.blockAlign
		if frames > 0 {
			s.lastData = time.Now()
			if active {
				if flags&AUDCLNT_BUFFERFLAGS_SILENT != 0 || data == 0 || s.muted {
					s.out.silence(int64(frames))
				} else {
					buf := unsafe.Slice((*byte)(unsafe.Pointer(data)), n)
					s.measure(buf)
					s.out.write(buf)
				}
				s.frames += int64(frames)
			}
		}
		call(s.capture, 4, uintptr(frames))
	}
}

func (s *stream) measure(b []byte) {
	step := s.fmt.blockAlign * 8
	for i := 0; i+4 <= len(b); i += step {
		var v float64
		switch {
		case s.fmt.isFloat && s.fmt.bits == 32:
			v = float64(math.Float32frombits(binary.LittleEndian.Uint32(b[i:])))
		case s.fmt.bits == 16:
			v = float64(int16(binary.LittleEndian.Uint16(b[i:]))) / 32768
		case s.fmt.bits == 32:
			v = float64(int32(binary.LittleEndian.Uint32(b[i:]))) / 2147483648
		}
		if v < 0 {
			v = -v
		}
		if v > s.peak {
			s.peak = v
		}
	}
}

func (s *stream) close() {
	call(s.client, 11) // Stop
	release(s.capture)
	release(s.client)
	s.out.close()
}

// ---------------------------------------------------------------- main
func main() {
	sysPath := flag.String("sys", "", "WAV file for the speaker output")
	micPath := flag.String("mic", "", "WAV file for the microphone")
	micName := flag.String("micname", "", "microphone name (default device if empty or not found)")
	flag.Parse()

	runtime.LockOSThread()
	out := bufio.NewWriter(os.Stdout)
	var outMu sync.Mutex
	say := func(f string, a ...interface{}) {
		outMu.Lock()
		fmt.Fprintf(out, f+"\n", a...)
		out.Flush()
		outMu.Unlock()
	}

	procCoInitializeEx.Call(0, COINIT_MULTITHREADED)
	var enum uintptr
	r, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&CLSID_MMDeviceEnumerator)), 0, CLSCTX_ALL,
		uintptr(unsafe.Pointer(&IID_IMMDeviceEnumerator)), uintptr(unsafe.Pointer(&enum)))
	if err := hr("CoCreateInstance", r); err != nil {
		say("ERROR %v", err)
		os.Exit(1)
	}

	var streams []*stream
	if *sysPath != "" {
		s, err := openStream(enum, "sys", "", *sysPath)
		if err != nil {
			say("ERROR speaker capture: %v", err)
			os.Exit(1)
		}
		streams = append(streams, s)
		say("READY sys %d %d %d %v", s.fmt.rate, s.fmt.channels, s.fmt.bits, s.fmt.isFloat)
	}
	if *micPath != "" {
		s, err := openStream(enum, "mic", *micName, *micPath)
		if err != nil {
			say("NOMIC %v", err)
		} else {
			streams = append(streams, s)
			say("READY mic %d %d %d %v", s.fmt.rate, s.fmt.channels, s.fmt.bits, s.fmt.isFloat)
		}
	}
	if len(streams) == 0 {
		say("ERROR nothing to record")
		os.Exit(1)
	}

	// commands from SWT Capture
	cmds := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			cmds <- strings.TrimSpace(sc.Text())
		}
		cmds <- "stop" // parent went away
	}()

	var started, paused bool
	var startAt, pauseAt time.Time
	var pausedTotal time.Duration
	lastLevel := time.Now()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()

loop:
	for {
		select {
		case c := <-cmds:
			switch c {
			case "go":
				if !started {
					for _, s := range streams {
						s.drain(false) // throw away anything captured before "go"
						s.lastData = time.Now()
					}
					started, startAt = true, time.Now()
				}
			case "pause":
				if started && !paused {
					paused, pauseAt = true, time.Now()
				}
			case "resume":
				if paused {
					pausedTotal += time.Since(pauseAt)
					paused = false
					for _, s := range streams {
						s.lastData = time.Now()
					}
				}
			case "mute":
				for _, s := range streams {
					if s.kind == "mic" {
						s.muted = true
					}
				}
			case "unmute":
				for _, s := range streams {
					if s.kind == "mic" {
						s.muted = false
					}
				}
			case "stop":
				break loop
			}
		case <-tick.C:
			active := started && !paused
			for _, s := range streams {
				s.drain(active)
				// Windows sends no data while nothing is playing: fill those gaps with silence
				// so the sound stays in step with the picture.
				if active && time.Since(s.lastData) > 120*time.Millisecond {
					expected := int64((time.Since(startAt) - pausedTotal).Seconds() * float64(s.fmt.rate))
					if behind := expected - s.frames; behind > int64(s.fmt.rate/20) {
						s.out.silence(behind)
						s.frames += behind
					}
				}
			}
			if time.Since(lastLevel) > 100*time.Millisecond {
				lastLevel = time.Now()
				var sp, mp float64
				for _, s := range streams {
					if s.kind == "sys" {
						sp = s.peak
					} else {
						mp = s.peak
					}
					s.peak = 0
				}
				say("LEVEL %.3f %.3f", sp, mp)
			}
		}
	}
	for _, s := range streams {
		if started && !paused {
			s.drain(true)
		}
		s.close()
	}
	release(enum)
	say("DONE")
}
