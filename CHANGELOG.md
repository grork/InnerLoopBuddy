# Change Log
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/) and this project adheres to [Semantic Versioning](http://semver.org/).

## 1.2 (2023-12-10)
Fixed an issue where windows wouldn't open automatically due to node moving the
'default' name resolution order behaviour to follow the system, which results in
IPv6 often being favoured, and we were opening an IPv6 socket.

## 1.1 (2022-07-28)
Added a built in browser based on VS Code's Simple Browser
- Enabled availability checks before opening browser
- Added checkbox to enable cache bypass in the browser

## 1.0.0 (2022-04-24)
Initial release