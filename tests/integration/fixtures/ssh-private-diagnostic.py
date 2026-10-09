#!/usr/bin/python3
"""Emit a private fixture diagnostic, not application output or a real credential."""
import sys

sys.stderr.write("Sensitive transport diagnostic: " + sys.argv[1] + "\n")
sys.stderr.flush()
sys.exit(1)
