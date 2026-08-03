from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
import json
import pathlib
import sys

import pypdfium2 as pdfium


DM_OUT_BUFFER = 0x00000002
DM_IN_BUFFER = 0x00000008
DM_ORIENTATION = 0x00000001
DM_PAPERSIZE = 0x00000002
DM_PAPERLENGTH = 0x00000004
DM_PAPERWIDTH = 0x00000008
DM_COPIES = 0x00000100
DMPAPER_A4 = 9
DMORIENT_PORTRAIT = 1


class DEVMODEW(ctypes.Structure):
    _fields_ = [
        ("dmDeviceName", wintypes.WCHAR * 32),
        ("dmSpecVersion", wintypes.WORD),
        ("dmDriverVersion", wintypes.WORD),
        ("dmSize", wintypes.WORD),
        ("dmDriverExtra", wintypes.WORD),
        ("dmFields", wintypes.DWORD),
        ("dmOrientation", ctypes.c_short),
        ("dmPaperSize", ctypes.c_short),
        ("dmPaperLength", ctypes.c_short),
        ("dmPaperWidth", ctypes.c_short),
        ("dmScale", ctypes.c_short),
        ("dmCopies", ctypes.c_short),
        ("dmDefaultSource", ctypes.c_short),
        ("dmPrintQuality", ctypes.c_short),
        ("dmColor", ctypes.c_short),
        ("dmDuplex", ctypes.c_short),
        ("dmYResolution", ctypes.c_short),
        ("dmTTOption", ctypes.c_short),
        ("dmCollate", ctypes.c_short),
        ("dmFormName", wintypes.WCHAR * 32),
        ("dmLogPixels", wintypes.WORD),
        ("dmBitsPerPel", wintypes.DWORD),
        ("dmPelsWidth", wintypes.DWORD),
        ("dmPelsHeight", wintypes.DWORD),
        ("dmDisplayFlags", wintypes.DWORD),
        ("dmDisplayFrequency", wintypes.DWORD),
        ("dmICMMethod", wintypes.DWORD),
        ("dmICMIntent", wintypes.DWORD),
        ("dmMediaType", wintypes.DWORD),
        ("dmDitherType", wintypes.DWORD),
        ("dmReserved1", wintypes.DWORD),
        ("dmReserved2", wintypes.DWORD),
        ("dmPanningWidth", wintypes.DWORD),
        ("dmPanningHeight", wintypes.DWORD),
    ]


def _create_a4_dc(printer_name: str):
    import win32ui

    winspool = ctypes.WinDLL("winspool.drv", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    winspool.OpenPrinterW.argtypes = [
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.HANDLE),
        wintypes.LPVOID,
    ]
    winspool.OpenPrinterW.restype = wintypes.BOOL
    winspool.ClosePrinter.argtypes = [wintypes.HANDLE]
    winspool.ClosePrinter.restype = wintypes.BOOL
    winspool.DocumentPropertiesW.argtypes = [
        wintypes.HWND,
        wintypes.HANDLE,
        wintypes.LPWSTR,
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    winspool.DocumentPropertiesW.restype = ctypes.c_long
    gdi32.CreateDCW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.LPVOID,
    ]
    gdi32.CreateDCW.restype = wintypes.HDC

    printer = wintypes.HANDLE()
    if not winspool.OpenPrinterW(printer_name, ctypes.byref(printer), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = winspool.DocumentPropertiesW(None, printer, printer_name, None, None, 0)
        if size <= 0:
            raise OSError(f"프린터 설정을 읽지 못했습니다: {printer_name}")
        buffer = ctypes.create_string_buffer(size)
        if winspool.DocumentPropertiesW(
            None, printer, printer_name, buffer, None, DM_OUT_BUFFER
        ) < 0:
            raise OSError(f"프린터 설정을 초기화하지 못했습니다: {printer_name}")

        devmode = ctypes.cast(buffer, ctypes.POINTER(DEVMODEW)).contents
        devmode.dmFields |= (
            DM_ORIENTATION | DM_PAPERSIZE | DM_PAPERLENGTH | DM_PAPERWIDTH | DM_COPIES
        )
        devmode.dmOrientation = DMORIENT_PORTRAIT
        devmode.dmPaperSize = DMPAPER_A4
        devmode.dmPaperWidth = 2100
        devmode.dmPaperLength = 2970
        devmode.dmCopies = 1
        if winspool.DocumentPropertiesW(
            None,
            printer,
            printer_name,
            buffer,
            buffer,
            DM_IN_BUFFER | DM_OUT_BUFFER,
        ) < 0:
            raise OSError(f"프린터가 A4 설정을 거부했습니다: {printer_name}")

        handle = gdi32.CreateDCW("WINSPOOL", printer_name, None, buffer)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        return win32ui.CreateDCFromHandle(handle)
    finally:
        winspool.ClosePrinter(printer)


def _device_info(dc) -> dict[str, int]:
    import win32con

    return {
        "dpi_x": dc.GetDeviceCaps(win32con.LOGPIXELSX),
        "dpi_y": dc.GetDeviceCaps(win32con.LOGPIXELSY),
        "physical_width": dc.GetDeviceCaps(win32con.PHYSICALWIDTH),
        "physical_height": dc.GetDeviceCaps(win32con.PHYSICALHEIGHT),
        "offset_x": dc.GetDeviceCaps(win32con.PHYSICALOFFSETX),
        "offset_y": dc.GetDeviceCaps(win32con.PHYSICALOFFSETY),
    }


def _actual_size_box(info: dict[str, int], width: int, height: int):
    left = (info["physical_width"] - width) // 2 - info["offset_x"]
    top = (info["physical_height"] - height) // 2 - info["offset_y"]
    return left, top, left + width, top + height


def _print_pdf(
    pdf_path: pathlib.Path,
    printer_name: str,
    placement: str,
    copies: int,
) -> None:
    from PIL import ImageWin

    if placement not in {"actual", "full_page"}:
        raise ValueError(f"지원하지 않는 배치 방식입니다: {placement}")
    if not pdf_path.is_file():
        raise FileNotFoundError(pdf_path)
    with pdf_path.open("rb") as stream:
        if stream.read(5) != b"%PDF-":
            raise ValueError(f"PDF 파일이 아닙니다: {pdf_path}")

    document = pdfium.PdfDocument(str(pdf_path))
    dc = _create_a4_dc(printer_name)
    try:
        info = _device_info(dc)
        for copy_index in range(copies):
            dc.StartDoc(f"{pdf_path.stem}-{copy_index + 1}")
            try:
                for page_index in range(len(document)):
                    page = document[page_index]
                    try:
                        bitmap = page.render(scale=info["dpi_x"] / 72)
                        image = bitmap.to_pil().convert("RGB")
                        try:
                            if placement == "actual":
                                box = _actual_size_box(info, image.width, image.height)
                            else:
                                box = (
                                    -info["offset_x"],
                                    -info["offset_y"],
                                    info["physical_width"] - info["offset_x"],
                                    info["physical_height"] - info["offset_y"],
                                )
                            dc.StartPage()
                            try:
                                ImageWin.Dib(image).draw(dc.GetHandleOutput(), box)
                            finally:
                                dc.EndPage()
                        finally:
                            image.close()
                    finally:
                        page.close()
                dc.EndDoc()
            except Exception:
                dc.AbortDoc()
                raise
    finally:
        dc.DeleteDC()
        document.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest-base64", required=True)
    args = parser.parse_args()
    manifest = json.loads(base64.b64decode(args.manifest_base64).decode("utf-8"))
    printer_name = str(manifest["printerName"])
    copies = int(manifest["copies"])
    if copies < 1 or copies > 5:
        raise ValueError("인쇄 부수는 1~5 사이여야 합니다.")
    files = list(manifest["files"])
    if not files:
        raise ValueError("인쇄할 쉽먼트 문서가 없습니다.")

    submitted: list[str] = []
    for item in files:
        path = pathlib.Path(str(item["filePath"])).expanduser().resolve()
        _print_pdf(path, printer_name, str(item["placement"]), copies)
        submitted.append(str(item["fileName"]))
    print(
        json.dumps(
            {
                "success": True,
                "status": "submitted",
                "submittedFiles": submitted,
                "message": (
                    f"{printer_name}에 쉽먼트 문서 {len(submitted)}개를 "
                    "A4 규격으로 제출했습니다."
                ),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
