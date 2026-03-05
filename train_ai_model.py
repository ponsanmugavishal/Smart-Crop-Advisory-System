from ai_module import MODEL_FILE_PATH, ensure_model_ready, retrain_model_with_report


def main() -> None:
    report = retrain_model_with_report()
    if not report:
        print("AI model training failed. Install requirements and try again.")
        return

    ready = ensure_model_ready()
    if ready:
        print(f"AI model is ready at: {MODEL_FILE_PATH}")
        print(f"Training report: {report}")
    else:
        print("AI model was trained but could not be loaded.")


if __name__ == "__main__":
    main()
