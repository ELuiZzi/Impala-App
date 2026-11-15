// Sin consola de Windows en la versión compilada.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    impala_desktop_lib::run()
}
