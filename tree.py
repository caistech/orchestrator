import os

EXCLUDED_DIRS = {'.git', '.venv', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache', '.next',
                 'build', 'dist'}


def print_tree(start_path, prefix='', max_depth=None, current_depth=0):
    if max_depth is not None and current_depth >= max_depth:
        return

    try:
        entries = []
        for e in os.listdir(start_path):
            # Skip excluded dirs and hidden files (except specific ones we want)
            if e in EXCLUDED_DIRS:
                continue
            if e.startswith('.') and e not in ['.env', '.env.local']:
                continue
            entries.append(e)

        entries.sort()

        for index, entry in enumerate(entries):
            path = os.path.join(start_path, entry)
            connector = '└── ' if index == len(entries) - 1 else '├── '
            print(prefix + connector + entry)

            if os.path.isdir(path):
                extension = '    ' if index == len(entries) - 1 else '│   '
                print_tree(path, prefix + extension, max_depth, current_depth + 1)
    except PermissionError:
        print(prefix + "    [Permission Denied]")


if __name__ == '__main__':
    root_dir = os.path.dirname(os.path.abspath(__file__))
    print(f"📂 Project Directory Tree from: {root_dir}\n")
    print_tree(root_dir, max_depth=7)  # Limit depth to avoid huge output