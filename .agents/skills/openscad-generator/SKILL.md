---
name: "openscad-generator"
description: "Generates parameterized 3D models using Python templates and OpenSCAD, and compiles them to STL format via a Makefile. Invoke when generating custom STLs."
---

# OpenSCAD STL Generator

This skill provides a scalable methodology for generating parametric 3D models (STL files) using Python, OpenSCAD, and Make.

## When to Use

Invoke this skill when you need to programmatically generate multiple variations of a 3D model, create a catalog of STLs, or automate the conversion of parametric templates into 3D printable files.

## Architecture

1. **Python Script (`generate_catalog.py`)**: Acts as the template engine. It defines a base OpenSCAD (`.scad`) template with placeholders (e.g., `{width}`, `{shape}`) and loops over combinations of parameters to generate individual `.scad` files.
2. **OpenSCAD CLI**: Used as the compiler to render `.scad` files into binary `.stl` files.
3. **Makefile**: Orchestrates the build process, ensuring only modified `.scad` files are recompiled, and handles the discovery of the `openscad` executable across platforms.

## Step-by-Step Implementation

### 1. The Python Generator
Create a Python script that writes `.scad` files. Use Python's string formatting to inject parameters into an OpenSCAD template.

**Important**: Because OpenSCAD uses curly braces `{}` for blocks, you must double them (`{{` and `}}`) in the Python template string so they aren't interpreted as format placeholders.

```python
import os

SCAD_TEMPLATE = """// Parametric Model
module item(w, l) {{
    cube([w, l, 10]);
}}

item({width}, {length});
"""

def generate_catalog():
    os.makedirs("scad_models", exist_ok=True)
    
    # Define combinations
    variants = [
        (10, 20), 
        (15, 30)
    ]
    
    for w, l in variants:
        filename = f"scad_models/item_{w}x{l}.scad"
        content = SCAD_TEMPLATE.format(width=w, length=l)
        with open(filename, "w") as f:
            f.write(content)
        print(f"Generated {filename}")

if __name__ == "__main__":
    generate_catalog()
```

### 2. The Makefile
Use a Makefile to automate the STL compilation. It should intelligently detect the OpenSCAD executable (especially on macOS where it resides in `/Applications`).

```makefile
.PHONY: all clean scad stl

# Detect OpenSCAD (handles Linux/macOS paths)
OPENSCAD_CMD := $(shell command -v openscad 2> /dev/null)
ifndef OPENSCAD_CMD
	ifneq ("$(wildcard /Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD)","")
		OPENSCAD_CMD := /Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD
	endif
endif

SCAD_FILES := $(wildcard scad_models/*.scad)
STL_FILES := $(patsubst scad_models/%.scad,stl_models/%.stl,$(SCAD_FILES))

all: stl

scad:
	python3 generate_catalog.py

stl: scad $(STL_FILES)

stl_models/%.stl: scad_models/%.scad
	@mkdir -p stl_models
	@if [ -z "$(OPENSCAD_CMD)" ]; then \
		echo "Error: OpenSCAD not found."; \
		exit 1; \
	fi
	$(OPENSCAD_CMD) -o $@ $<
	@echo "Compiled $@"

clean:
	rm -rf scad_models stl_models
```

### 3. Execution

1. **Generate Templates**: Run `make scad` to execute the Python script and generate the `.scad` files.
2. **Compile to STL**: Run `make stl` (or just `make`) to compile the `.scad` files into `.stl` files.
3. **Clean Build**: Run `make clean` to wipe generated directories.

## Best Practices

- **Separation of Concerns**: Keep the geometric logic entirely within OpenSCAD modules and handle the configuration/catalog loop exclusively in Python.
- **Directory Structure**: Always separate `.scad` files into `scad_models/` and `.stl` files into `stl_models/` to keep the repository clean.
- **Parametric OpenSCAD Code**: Ensure OpenSCAD scripts are heavily parameterized so the Python script only needs to inject top-level variables.
