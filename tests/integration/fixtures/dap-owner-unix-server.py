#!/usr/bin/env python3
"""Owned Unix peer that records any received protocol byte for routing-refusal tests."""
import socket
import sys

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
    server.bind(sys.argv[1])
    server.listen(1)
    connection, _address = server.accept()
    with connection:
        received = connection.recv(16384)
        if received:
            with open(sys.argv[2], "w", encoding="ascii") as stream:
                stream.write("received protocol bytes")
