// A minimal Cortex-M program for the smoke test: a vector table in the
// .vector_table section (as Klipper's src/generic/armcm_boot.c produces through
// its DECL_ARMCM_IRQ machinery), a reset handler that copies .data, clears
// .bss and runs a loop, and enough library use to pull memset, the EABI
// memory helpers and a 64-bit division out of libc.a and
// libclang_rt.builtins.a. It links with Klipper's armcm_link.lds.S unchanged.
//
// Copyright (C) 2026 Isik's Tech. GPL-3.0.

#include <stdint.h>
#include <string.h>

extern uint32_t _stack_end, _data_start, _data_end, _data_flash;
extern uint32_t _bss_start, _bss_end;

void ResetHandler(void);

void
DefaultHandler(void)
{
    for (;;)
        ;
}

// Entry 0 is the initial stack pointer, entry 1 the reset handler (Thumb bit
// set by the linker), then NMI, HardFault and the rest of the system handlers.
__attribute__((section(".vector_table"), used))
const void *VectorTable[16 + 32] = {
    &_stack_end, ResetHandler, DefaultHandler, DefaultHandler,
    DefaultHandler, DefaultHandler, DefaultHandler, 0, 0, 0, 0,
    DefaultHandler, DefaultHandler, 0, DefaultHandler, DefaultHandler,
};

static uint32_t initialized_value = 0x12345678;   // lives in .data
static uint8_t scratch[256];                       // lives in .bss
volatile uint64_t ticks;

static uint32_t
mix(uint32_t x)
{
    ticks += x;
    return (uint32_t)(ticks / 7u) ^ initialized_value;   // __aeabi_uldivmod
}

void __attribute__((noreturn))
ResetHandler(void)
{
    uint32_t *src = &_data_flash, *dst = &_data_start;
    while (dst < &_data_end)
        *dst++ = *src++;
    memset(&_bss_start, 0, (uintptr_t)&_bss_end - (uintptr_t)&_bss_start);
    for (;;) {
        uint32_t v = mix(scratch[ticks & 0xff]);
        scratch[v & 0xff] = (uint8_t)v;
        __asm__ volatile("" ::: "memory");
    }
}
